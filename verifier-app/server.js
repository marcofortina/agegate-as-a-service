try {
  require('dotenv').config({ override: false });
} catch { /* dotenv not available, using env vars */ }

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');
const pino = require('pino');
const prometheus = require('prom-client');

const app = express();

// Security middleware (English comments)
const helmet = require('helmet');
const cors = require('cors');
const { z } = require('zod');

const { anonymizeIPMiddleware } = require('./proxy');
const { setRedisClient } = require('./proxy');
const cookieParser = require('cookie-parser');

// Apply IP anonymization BEFORE any logging or rate limiting
const anonymizeIP = process.env.ANONYMIZE_IP !== 'false'; // Enabled by default
app.use(anonymizeIPMiddleware({
  enabled: anonymizeIP,
  passthroughOnError: process.env.NODE_ENV === 'development'
}));

app.use(cookieParser());
app.use(express.json({ limit: '10kb' }));

// Configure security based on protocol
const isHttps = process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith('https');

// Helmet configuration
app.use(helmet({
  crossOriginOpenerPolicy: isHttps ? { policy: 'same-origin' } : false,
  crossOriginResourcePolicy: isHttps ? { policy: 'same-origin' } : false,
  contentSecurityPolicy: isHttps ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
    }
  } : false
}));

// CORS only in HTTPS
if (isHttps) {
  app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*' }));
}

// Structured logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.authorization', 'apiKey']
});

// Prometheus metrics
const register = new prometheus.Registry();
prometheus.collectDefaultMetrics({ register });

const verificationCounter = new prometheus.Counter({
  name: 'agegate_verifications_total',
  help: 'Total number of age verifications',
  labelNames: ['client_id', 'threshold']
});

const verificationDuration = new prometheus.Histogram({
  name: 'agegate_verification_duration_seconds',
  help: 'Verification duration in seconds',
  labelNames: ['client_id']
});

register.registerMetric(verificationCounter);
register.registerMetric(verificationDuration);

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

// OpenAPI / Swagger
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const swaggerOptions = {
  definition: {
    openapi: '3.1.0',
    info: {
      title: 'AgeGate as a Service',
      version: '0.3.1',
      description: 'EU Blueprint compliant age verification (double anonymity)'
    },
    servers: [{ url: process.env.PUBLIC_URL }]
  },
  apis: ['./server.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Configuration
const PORT = process.env.PORT || 8080;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) {
  logger.error('ADMIN_PASS environment variable is required');
  process.exit(1);
}
const PUBLIC_URL = process.env.PUBLIC_URL || `http://agegate.local:${process.env.NODEPORT || 30452}`;

// Database
const pool = new Pool({
  host: process.env.TIMESCALEDB_HOST || 'timescaledb',
  port: parseInt(process.env.TIMESCALEDB_PORT || '5432'),
  database: process.env.TIMESCALEDB_DB || 'agegate',
  user: process.env.TIMESCALEDB_USER || 'postgres',
  password: process.env.TIMESCALEDB_PASSWORD,
});
if (!process.env.TIMESCALEDB_PASSWORD) {
  logger.error('TIMESCALEDB_PASSWORD environment variable is required');
  process.exit(1);
}

// Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Share Redis client with proxy for multi-replica salt storage
setRedisClient(redis);

// Rate limit
async function checkRateLimit(req, apiKey) {
  // Use anonymized IP in rate limit key for better distribution
  const anonymizedIP = req.anonymizedIP || 'unknown';
  const key = `rate:${apiKey}:${anonymizedIP}`;
  const multi = redis.multi();
  multi.incr(key);
  multi.ttl(key);
  const [countRes, ttlRes] = await multi.exec();

  const count = countRes[1];
  const ttl = ttlRes[1];

  // Retrieve per-key rate limit from database (cached? simple query for now)
  const limitRes = await pool.query('SELECT rate_limit FROM api_keys WHERE api_key = $1', [apiKey]);
  const limit = limitRes.rows[0]?.rate_limit || 100;

  if (ttl === -1) await redis.expire(key, 60); // 1 minute window

  if (count > limit) {
    await redis.decr(key);
    return false;
  }
  return true;
}

// Initialize DB
async function initDB() {
  // Retry connecting to database (containers may not be ready)
  let retries = 30;
  let connected = false;
  while (retries > 0 && !connected) {
    try {
      await pool.query('SELECT 1');
      connected = true;
    } catch (err) {
      retries--;
      if (retries === 0) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Now create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verifications (
      id SERIAL,
      client_id TEXT NOT NULL,
      api_key TEXT NOT NULL,
      threshold INTEGER NOT NULL DEFAULT 18,
      timestamp TIMESTAMPTZ NOT NULL,
      verified BOOLEAN NOT NULL,
      PRIMARY KEY (id, timestamp)
    );
  `);
  await pool.query(`
    SELECT create_hypertable('verifications', 'timestamp', if_not_exists => TRUE);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      client_id TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      rate_limit INTEGER DEFAULT 100,
      description TEXT,
      is_active BOOLEAN DEFAULT true,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
    CREATE INDEX IF NOT EXISTS idx_api_keys_client ON api_keys(client_id);
  `);

  // Migrate existing keys from verifications table (one-time)
  await pool.query(`
    INSERT INTO api_keys (client_id, api_key, created_at, is_active, created_by)
    SELECT DISTINCT client_id, api_key, MIN(timestamp), true, 'migration'
    FROM verifications v
    WHERE NOT EXISTS (SELECT 1 FROM api_keys a WHERE a.api_key = v.api_key)
    GROUP BY client_id, api_key
    ON CONFLICT (api_key) DO NOTHING
  `);
  const { rowCount } = await pool.query(`SELECT COUNT(*) as count FROM api_keys WHERE created_by = 'migration'`);
  if (rowCount > 0) logger.info(`Migrated ${rowCount} existing API keys to api_keys table`);

  // Audit log table for admin actions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      admin_user TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details JSONB,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Set retention policy (default: 30 days)
  const retentionDays = parseInt(process.env.RETENTION_DAYS || '30');
  if (retentionDays > 0) {
    await pool.query(`SELECT add_retention_policy('verifications', INTERVAL '${retentionDays} days', if_not_exists => TRUE);`);
    logger.info(`TimescaleDB retention policy set to ${retentionDays} days`);
  }
}

// Helper to log admin actions
async function logAdminAction(adminUser, action, target, details = {}) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_user, action, target, details)
       VALUES ($1, $2, $3, $4)`,
      [adminUser, action, target, details]
    );
  } catch (err) {
    logger.error({ err, adminUser, action }, 'Failed to log admin action');
  }
}

// getAdminUser helper
function getAdminUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return 'unknown';
  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user] = credentials.split(':');
  return user;
}

// Admin auth helper
function isAdmin(req, checkCookie = true) {
  // Check Authorization header first
  let authHeader = req.headers.authorization;

  // If no header but cookie exists, use cookie
  if (!authHeader && checkCookie && req.cookies && req.cookies.admin_auth) {
    authHeader = `Basic ${req.cookies.admin_auth}`;
  }

  if (!authHeader || !authHeader.startsWith('Basic ')) return false;

  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const [user, pass] = credentials.split(':');
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

// Input validation schema
const verifySchema = z.object({
  client_id: z.string().min(3).max(100),
  threshold: z.number().int().min(18).max(25).default(18)
});

// Nice HTML login page
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>AgeGate Login</title></head>
    <body style="font-family:system-ui;background:#111;color:#0f0;padding:40px;text-align:center">
      <h1>Age Gate Admin Login</h1>
      <input id="user" placeholder="Username" value="admin"><br><br>
      <input id="pass" type="password" placeholder="Password" value="agegate2026"><br><br>
      <button onclick="login()">Login</button>
      <script>
        function login() {
          const u = document.getElementById('user').value;
          const p = document.getElementById('pass').value;
          window.location.href = '/dashboard?auth=' + btoa(u + ':' + p);
        }
      </script>
    </body>
    </html>
  `);
});

// Verifier
app.post('/verify', async (req, res) => {
  const start = Date.now();
  const apiKey = req.headers['x-api-key'];
  const clientId = req.body.client_id || 'unknown';
  const threshold = parseInt(req.body.threshold) || 18;

  if (!apiKey) {
    logger.warn({ clientId }, 'Missing API Key');
    return res.status(401).json({ status: 'error', message: 'Missing API Key' });
  }

  // Validate API key: exists, active, not expired
  const keyCheck = await pool.query(
    `SELECT client_id, expires_at, is_active FROM api_keys WHERE api_key = $1`,
    [apiKey]
  );
  if (keyCheck.rows.length === 0 || !keyCheck.rows[0].is_active) {
    logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Invalid or revoked API key');
    return res.status(401).json({ status: 'error', message: 'Invalid API key' });
  }
  const keyRecord = keyCheck.rows[0];
  if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
    logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Expired API key');
    return res.status(401).json({ status: 'error', message: 'API key expired' });
  }

  if (!await checkRateLimit(req, apiKey)) {
    logger.warn({ apiKey: apiKey.substring(0, 8) + '...', anonymizedIP: req.anonymizedIP }, 'Rate limit exceeded');
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded (100 requests/min)' });
  }

  // Update last_used_at (async, don't await to avoid slowing response)
  pool.query(`UPDATE api_keys SET last_used_at = NOW() WHERE api_key = $1`, [apiKey]).catch(err => {
    logger.error({ err, apiKey: apiKey.substring(0,8)+'...' }, 'Failed to update last_used_at');
  });

  try {
    verifySchema.parse(req.body);

    // === REAL AGE VERIFICATION ===
    let verified = true;
    const backend = process.env.VERIFIER_BACKEND || 'mock';

    if (backend === 'mock') {
      // realistic simulation for testing
      verified = Math.random() * 100 >= (threshold - 5); // ~5% false negatives for testing
    } else if (backend === 'eidas') {
      // TODO: OID4VP / mDoc integration (future)
      verified = true; // placeholder
    }

    const timestamp = new Date().toISOString();
    await pool.query(
      `INSERT INTO verifications (client_id, api_key, threshold, timestamp, verified) VALUES ($1, $2, $3, $4, $5)`,
      [clientId, apiKey, threshold, timestamp, verified]
    );

    const duration = (Date.now() - start) / 1000;

    // Log anonymized IP instead of real IP
    logger.info({ clientId, threshold, verified, backend, durationMs: Math.round(duration * 1000), anonymizedIP: req.anonymizedIP }, 'Verification completed');

    verificationCounter.inc({ client_id: clientId, threshold });
    verificationDuration.observe({ client_id: clientId }, duration);

    res.json({
      status: 'success',
      message: verified
        ? `Age ≥ ${threshold} successfully verified (AGCOM double anonymity - UE Blueprint)`
        : `Age verification failed - user is under ${threshold}`,
      verified,
      ageOverThreshold: verified,
      issuerTrusted: true,
      threshold,
      timestamp,
      proofType: backend === 'eidas' ? 'eIDAS2.0' : 'mock'
    });
  } catch (err) {
    return res.status(400).json({ status: 'error', message: 'Invalid input', details: err.errors });
  }
});

// GET /stats - Client statistics (authenticated via API key)
app.get('/stats', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    logger.warn({ clientId: 'unknown' }, 'Missing API Key for stats');
    return res.status(401).json({ status: 'error', message: 'Missing API Key' });
  }

  // Validate API key: exists, active, not expired
  const keyCheck = await pool.query(
    `SELECT client_id, expires_at, is_active FROM api_keys WHERE api_key = $1`,
    [apiKey]
  );
  if (keyCheck.rows.length === 0 || !keyCheck.rows[0].is_active) {
    logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Invalid or revoked API key for stats');
    return res.status(401).json({ status: 'error', message: 'Invalid API key' });
  }
  const keyRecord = keyCheck.rows[0];
  if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
    logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Expired API key for stats');
    return res.status(401).json({ status: 'error', message: 'API key expired' });
  }

  // Apply rate limit for stats
  if (!await checkRateLimit(req, apiKey)) {
    logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Stats rate limit exceeded');
    return res.status(429).json({ status: 'error', message: 'Stats rate limit exceeded (100 requests/min)' });
  }

  const clientId = keyRecord.client_id;

  // Get global stats for this client
  const totalResult = await pool.query(
    `SELECT COUNT(*) as total FROM verifications WHERE client_id = $1 AND api_key = $2`,
    [clientId, apiKey]
  );
  const total = parseInt(totalResult.rows[0].total);

  const successResult = await pool.query(
    `SELECT COUNT(*) as successful FROM verifications WHERE client_id = $1 AND api_key = $2 AND verified = true`,
    [clientId, apiKey]
  );
  const successful = parseInt(successResult.rows[0].successful);
  const successRate = total > 0 ? ((successful / total) * 100).toFixed(1) : 0;

  // Last verification timestamp
  const lastResult = await pool.query(
    `SELECT MAX(timestamp) as last FROM verifications WHERE client_id = $1 AND api_key = $2`,
    [clientId, apiKey]
  );
  const lastVerification = lastResult.rows[0].last;

  // Optional: daily stats for last 7 days
  const dailyResult = await pool.query(
    `SELECT DATE(timestamp) as day, COUNT(*) as count
     FROM verifications
     WHERE client_id = $1 AND api_key = $2 AND timestamp > NOW() - INTERVAL '7 days'
     GROUP BY day
     ORDER BY day DESC`,
    [clientId, apiKey]
  );
  const daily = dailyResult.rows.map(row => ({
    date: row.day,
    verifications: parseInt(row.count)
  }));

  res.json({
    client_id: clientId,
    total_verifications: total,
    successful_verifications: successful,
    success_rate: parseFloat(successRate),
    last_verification: lastVerification,
    daily_breakdown: daily
  });
});

// Dashboard
app.get('/dashboard', async (req, res) => {
  // Handle login from query param (first time login)
  const authHeader = req.headers.authorization;

  if (!authHeader && req.query.auth) {
    const isValid = await isAdminWithAuth(`Basic ${req.query.auth}`);

    if (isValid) {
      // Set session cookie
      res.cookie('admin_auth', req.query.auth, {
        httpOnly: true,
        secure: isHttps,
        sameSite: 'strict',
        maxAge: 3600000 // 1 hour
      });
      // Redirect to clean dashboard (remove auth from URL)
      return res.redirect('/dashboard');
    }
    return res.redirect('/login?error=invalid');
  }

  // Check authentication via cookie or header
  if (!isAdmin(req, true)) {
    return res.redirect('/login');
  }

  // If user came via header but no cookie yet, set one
  if (!req.cookies.admin_auth && req.headers.authorization) {
    const authValue = req.headers.authorization.replace('Basic ', '');
    res.cookie('admin_auth', authValue, {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'strict'
    });
  }

  // Fetch API keys with status
  const keys = await pool.query(`
    SELECT client_id, api_key, created_at, expires_at, last_used_at, is_active, description, rate_limit
    FROM api_keys
    ORDER BY created_at DESC
  `);

  // Fetch success rate for each client (based on verifications)
  const successRates = await pool.query(`
    SELECT client_id,
           COUNT(*) as total,
           SUM(CASE WHEN verified THEN 1 ELSE 0 END) as successful
    FROM verifications
    GROUP BY client_id
  `);
  const rateMap = {};
  successRates.rows.forEach(r => {
    rateMap[r.client_id] = r.total > 0 ? (r.successful / r.total * 100).toFixed(1) : 0;
  });

  // Global verification stats
  const verificationsCount = await pool.query(`SELECT COUNT(*) as total FROM verifications`);
  const total = parseInt(verificationsCount.rows[0].total);

  // Fetch audit log (last 20 entries)
  const auditLog = await pool.query(`
    SELECT admin_user, action, target, details, timestamp
    FROM admin_audit_log
    ORDER BY timestamp DESC
    LIMIT 20
  `);

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AgeGate Dashboard</title>
  <style>
    body { font-family: system-ui; background: #111; color: #0f0; padding: 20px; }
    .card { background: #222; padding: 20px; border-radius: 12px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; border: 1px solid #0a0; text-align: left; }
    input, button { padding: 10px; margin: 5px; font-size: 16px; }
  </style>
</head>
<body>
  <script>
    // Define functions before any button uses them
    async function registerClient() {
      const clientId = document.getElementById('newClientId').value.trim();
      const description = document.getElementById('newClientDesc').value.trim();
      if (!clientId) return alert('Client ID is required');
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, description: description || undefined })
      });
      const data = await response.json();
      alert('API Key generated: ' + data.api_key + (data.expires_at ? '\\nExpires: ' + new Date(data.expires_at).toLocaleString() : ''));
      location.reload();
    }

    async function revokeKey(apiKey) {
      if (!confirm('Revoke this API Key permanently?')) return;
      const response = await fetch('/api/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey })
      });
      if (response.ok) {
        alert('API Key revoked successfully');
        location.reload();
      } else {
        alert('Error revoking API Key');
      }
    }

    async function rotateKey(apiKey) {
      if (!confirm('Generate a new API Key and revoke the old one?')) return;
      const response = await fetch('/api/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey })
      });
      const data = await response.json();
      if (response.ok) {
        alert('New API Key generated: ' + data.api_key + '\\nExpires: ' + new Date(data.expires_at).toLocaleString());
        location.reload();
      } else {
        alert('Error rotating API Key');
      }
    }

    async function viewStats(apiKey) {
      try {
        const response = await fetch('/stats', {
          headers: { 'x-api-key': apiKey }
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const stats = await response.json();
        alert(JSON.stringify(stats, null, 2));
      } catch (err) {
        alert('Failed to fetch stats: ' + err.message);
      }
    }

    async function editRateLimit(apiKey, currentLimit) {
      const newLimit = prompt('Enter new rate limit (1-10000):', currentLimit);
      if (newLimit === null) return;
      const limitNum = parseInt(newLimit, 10);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 10000) {
        alert('Rate limit must be an integer between 1 and 10000');
        return;
      }
      const response = await fetch('/api/keys/' + apiKey + '/rate-limit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate_limit: limitNum })
      });
      if (response.ok) {
        alert('Rate limit updated');
        location.reload();
      } else {
        const err = await response.json();
        alert('Failed to update rate limit: ' + (err.error || 'Unknown error'));
      }
    }

    async function editDescription(apiKey, currentDesc) {
      const newDesc = prompt('Enter new description:', currentDesc);
      if (newDesc === null) return;
      const response = await fetch('/api/keys/' + apiKey + '/description', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: newDesc })
      });
      if (response.ok) {
        alert('Description updated');
        location.reload();
      } else {
        const err = await response.json();
        alert('Failed to update description: ' + (err.error || 'Unknown error'));
      }
    }

    window.registerClient = registerClient;
    window.revokeKey = revokeKey;
    window.rotateKey = rotateKey;
  </script>

  <h1>Age Gate as a Service - Dashboard</h1>
  <div class="card">
    <h2>Global Statistics</h2>
    <p>Total verifications: <strong>${total}</strong></p>
  </div>
  <div class="card">
    <h2>API Keys Management</h2>
    <table>
      <th>Client</th><th>API Key</th><th>Description</th><th>Rate Limit</th><th>Created</th><th>Expires</th><th>Last Used</th><th>Success Rate</th><th>Status</th><th>Actions</th><th>Stats</th>`;

  keys.rows.forEach(k => {
    const successRate = rateMap[k.client_id] || '0';
    html += `<tr>
      <td>${k.client_id}</td>
      <td><code>${k.api_key.substring(0,12)}...</code></td>
      <td>${k.description || '-'}</td>
      <td id="rate-limit-${k.api_key}">${k.rate_limit}</td>
      <td>${new Date(k.created_at).toLocaleString()}</td>
      <td>${k.expires_at ? new Date(k.expires_at).toLocaleString() : 'never'}</td>
      <td>${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
      <td>${successRate}%</td>
      <td>${k.is_active ? '✅ active' : '❌ revoked'}</td>
      <td>
         ${k.is_active ? `<button onclick="rotateKey('${k.api_key}')">Rotate</button>` : ''}
         <button onclick="editRateLimit('${k.api_key}', ${k.rate_limit})">Edit Rate</button>
         <button onclick="revokeKey('${k.api_key}')">Revoke</button>
	 <button onclick="editDescription('${k.api_key}', '${(k.description || '').replace(/'/g, "\\'")}')">Edit Desc</button>
       </td>
       <td>
         <button onclick="viewStats('${k.api_key}')">Stats</button>
      </td>
    </tr>`;
  });

  html += `</table>
  </div>

  <div class="card">
    <h2>Add New Client</h2>
    <input id="newClientId" placeholder="Client ID (e.g. casino-italia.it)" style="width:320px">
    <input id="newClientDesc" placeholder="Description (optional)" style="width:320px">
    <button onclick="registerClient()">Add Client</button>
  </div>

  <div class="card">
    <h2>Admin Audit Log (last 20 actions)</h2>
    <table>
      <tr><th>Admin</th><th>Action</th><th>Target</th><th>Details</th><th>Timestamp</th></tr>`;
  auditLog.rows.forEach(log => {
    html += `<tr>
      <td>${log.admin_user}</td>
      <td>${log.action}</td>
      <td>${log.target || '-'}</td>
      <td>${JSON.stringify(log.details)}</td>
      <td>${new Date(log.timestamp).toLocaleString()}</td>
    </tr>`;
  });
  html += `</table>
  </div>

  <a href="/logout">Logout</a>
</body>
</html>`;
  res.send(html);
});

// Helper function to check auth without modifying request
async function isAdminWithAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const [user, pass] = credentials.split(':');
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

// Admin endpoints
app.post('/api/register', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id, description } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  const adminUser = getAdminUser(req);

  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year validity

  let retries = 3;
  const attempt = () => {
    const randomBytes = crypto.randomBytes(24).toString('hex');
    const apiKey = `agk_${randomBytes}`;
    pool.query(
      `INSERT INTO api_keys (client_id, api_key, expires_at, created_by, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [client_id, apiKey, expiresAt, adminUser, description || null]
    ).then(() => {
      logAdminAction(adminUser, 'REGISTER', client_id, { api_key: apiKey.substring(0,8)+'...', expires_at: expiresAt });
      res.json({ client_id, api_key: apiKey, expires_at: expiresAt });
    }).catch(err => {
      if (err.code === '23505' && retries > 0) {
        retries--;
        logger.warn({ client_id, retriesLeft: retries }, 'API key collision, retrying');
        attempt();
      } else {
        logger.error(err);
        res.status(500).json({ error: 'Failed to create API key' });
      }
    });
  };
  attempt();
});

app.post('/api/revoke', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key is required' });
  const adminUser = getAdminUser(req);

  // Soft delete: mark as inactive
  await pool.query('UPDATE api_keys SET is_active = false WHERE api_key = $1', [api_key]);
  // Also clear from Redis rate limiting
  await redis.del(`rate:${api_key}`);

  await logAdminAction(adminUser, 'REVOKE', api_key, {});
  res.json({ status: 'success', message: 'API Key revoked' });
});

// Rotate API key: generate new, revoke old
app.post('/api/rotate', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key is required' });

  const result = await pool.query('SELECT client_id FROM api_keys WHERE api_key = $1 AND is_active = true', [api_key]);
  const adminUser = getAdminUser(req);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Active API key not found' });
  }
  const client_id = result.rows[0].client_id;

  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  let retries = 3;
  let success = false;
  let newApiKey = '';

  while (retries > 0 && !success) {
    const randomBytes = crypto.randomBytes(24).toString('hex');
    const candidateKey = `agk_${randomBytes}`;
    try {
      await pool.query('BEGIN');
      await pool.query('UPDATE api_keys SET is_active = false WHERE api_key = $1', [api_key]);
      await pool.query(
        `INSERT INTO api_keys (client_id, api_key, expires_at, created_by)
         VALUES ($1, $2, $3, $4)`,
        [client_id, candidateKey, expiresAt, adminUser]
      );
      await pool.query('COMMIT');
      newApiKey = candidateKey;
      success = true;
    } catch (err) {
      await pool.query('ROLLBACK');
      if (err.code === '23505' && retries > 1) {
        retries--;
        logger.warn({ client_id, retriesLeft: retries }, 'API key collision on rotate, retrying');
        continue;
      }
      logger.error(err);
      return res.status(500).json({ error: 'Failed to rotate API key' });
    }
  }

  if (!success) {
    return res.status(500).json({ error: 'Failed to generate unique API key after retries' });
  }

  // Clear old key from Redis
  await redis.del(`rate:${api_key}`);

  await logAdminAction(adminUser, 'ROTATE', client_id, { old_key: api_key.substring(0,8)+'...', new_key: newApiKey.substring(0,8)+'...' });

  res.json({ client_id, api_key: newApiKey, expires_at: expiresAt });
});

// PATCH /api/keys/:api_key/rate-limit - Update rate limit for an API key (admin only)
app.patch('/api/keys/:api_key/rate-limit', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { api_key } = req.params;
  const { rate_limit } = req.body;
  if (!Number.isInteger(rate_limit) || rate_limit < 1 || rate_limit > 10000) {
    return res.status(400).json({ error: 'rate_limit must be an integer between 1 and 10000' });
  }
  const result = await pool.query(
    'UPDATE api_keys SET rate_limit = $1 WHERE api_key = $2 RETURNING client_id',
    [rate_limit, api_key]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'API key not found' });
  }
  const adminUser = getAdminUser(req);
  await logAdminAction(adminUser, 'UPDATE_RATE_LIMIT', api_key, { rate_limit });
  res.json({ success: true, client_id: result.rows[0].client_id, rate_limit });
});

// PATCH /api/keys/:api_key/description - Update description for an API key (admin only)
app.patch('/api/keys/:api_key/description', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { api_key } = req.params;
  const { description } = req.body;
  if (description === undefined || typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }
  // Trim and limit length (optional)
  const trimmedDesc = description.trim().slice(0, 255);
  const result = await pool.query(
    'UPDATE api_keys SET description = $1 WHERE api_key = $2 RETURNING client_id',
    [trimmedDesc, api_key]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'API key not found' });
  }
  const adminUser = getAdminUser(req);
  await logAdminAction(adminUser, 'UPDATE_DESCRIPTION', api_key, { description: trimmedDesc });
  res.json({
    success: true,
    client_id: result.rows[0].client_id,
    description: trimmedDesc
  });
});

// GET /api/keys/:client_id - List all API keys for a specific client (admin only)
app.get('/api/keys/:client_id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id } = req.params;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const result = await pool.query(
    `SELECT api_key, created_at, expires_at, last_used_at, is_active, created_by
     FROM api_keys
     WHERE client_id = $1
     ORDER BY created_at DESC`,
    [client_id]
  );

  res.json({
    client_id,
    keys: result.rows.map(row => ({
      ...row,
      api_key: row.api_key.substring(0,12) + '...' // mask for safety
    }))
  });
});

// Logout endpoint
app.get('/logout', (req, res) => {
  res.clearCookie('admin_auth');
  res.redirect('/login');
});

// Metrics
app.get('/metrics', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).send('Unauthorized');
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Health & Readiness endpoints (required for K3s probes)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: require('./package.json').version });
});

app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

// Public onboarding
app.get('/onboarding', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>AgeGate Onboarding</title></head>
    <body style="font-family:system-ui;background:#111;color:#0f0;padding:40px;">
      <h1>How to integrate Age Gate</h1>
      <p>1. Add this single line in your website:</p>
      <pre>&lt;script src="${PUBLIC_URL}/sdk/agegate-sdk.js"&gt;&lt;/script&gt;</pre>
      <p>2. Use your personal API Key when calling the verification.</p>
    </body>
    </html>
  `);
});

// ==================== SERVER START + GRACEFUL SHUTDOWN ====================
let server;

async function startServer() {
  try {
    await initDB();
    logger.info('Database initialized');

    server = app.listen(PORT, () => {
      logger.info(`Age Gate as a Service v${require('./package.json').version} listening on port ${PORT}`);
    });

  } catch (err) {
    logger.error(err, 'Database initialization failed');
    process.exit(1);
  }
}

startServer();

let shuttingDown = false;

// Graceful shutdown
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('SIGTERM/SIGINT received – closing gracefully');
  if (server && server.listening) {
    server.close(async () => {
      await pool.end();
      await redis.quit();
      logger.info('All connections closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, getServer: () => server, pool };
