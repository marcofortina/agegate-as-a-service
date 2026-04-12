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
const session = require('express-session');
const PDFDocument = require('pdfkit');

const app = express();

// Security middleware (English comments)
const helmet = require('helmet');
const cors = require('cors');
const { z } = require('zod');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { doubleCsrf } = require('csrf-csrf');

const { anonymizeIPMiddleware } = require('./proxy');
const { setRedisClient } = require('./proxy');
const cookieParser = require('cookie-parser');

const isHttps = process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith('https');
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'test' ? 'test-session-secret' : null);
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required');
}

// Email transporter (configure via env)
const emailTransporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@agegate.local';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-02-24.acacia',
}) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Apply IP anonymization BEFORE any logging or rate limiting
const anonymizeIP = process.env.ANONYMIZE_IP !== 'false'; // Enabled by default
app.use(anonymizeIPMiddleware({
  enabled: anonymizeIP,
  passthroughOnError: process.env.NODE_ENV === 'development'
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

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

const rateLimitedCounter = new prometheus.Counter({
  name: 'agegate_rate_limited_total',
  help: 'Total number of rate limited requests (429)',
  labelNames: ['client_id', 'type']
});

register.registerMetric(verificationCounter);
register.registerMetric(verificationDuration);
register.registerMetric(rateLimitedCounter);

app.use('/sdk', express.static(path.join(__dirname)));

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

class RedisSessionStore extends session.Store {
  constructor(client, prefix = 'sess:') {
    super();
    this.client = client;
    this.prefix = prefix;
  }

  _key(sid) {
    return `${this.prefix}${sid}`;
  }

  _ttl(sessionData) {
    if (sessionData && sessionData.cookie && sessionData.cookie.expires) {
      const ttl = Math.ceil((new Date(sessionData.cookie.expires).getTime() - Date.now()) / 1000);
      return ttl > 0 ? ttl : 1;
    }
    if (sessionData && sessionData.cookie && sessionData.cookie.maxAge) {
      const ttl = Math.ceil(sessionData.cookie.maxAge / 1000);
      return ttl > 0 ? ttl : 1;
    }
    return 3600;
  }

  get(sid, cb) {
    this.client.get(this._key(sid))
      .then(data => cb(null, data ? JSON.parse(data) : null))
      .catch(err => cb(err));
  }

  set(sid, sessionData, cb) {
    const ttl = this._ttl(sessionData);
    this.client.set(this._key(sid), JSON.stringify(sessionData), 'EX', ttl)
      .then(() => cb && cb(null))
      .catch(err => cb && cb(err));
  }

  destroy(sid, cb) {
    this.client.del(this._key(sid))
      .then(() => cb && cb(null))
      .catch(err => cb && cb(err));
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}

const SESSION_SECRETS_KEY = 'session_secrets';
const SESSION_SECRET_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const SESSION_SECRET_RETENTION_MS = SESSION_SECRET_RETENTION_SECONDS * 1000;
const SESSION_SECRET_HISTORY_LIMIT = 8; // current + 7 previous daily secrets
const sessionSecretEntries = [{ secret: SESSION_SECRET, createdAt: Date.now() }];
const sessionSecrets = [SESSION_SECRET];

function syncSessionSecrets() {
  sessionSecrets.splice(0, sessionSecrets.length, ...sessionSecretEntries.map(entry => entry.secret));
}

function normalizeSessionSecretEntries(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(entry => {
        if (typeof entry === 'string') {
          return { secret: entry, createdAt: Date.now() };
        }
        if (entry && typeof entry.secret === 'string') {
          return {
            secret: entry.secret,
            createdAt: Number(entry.createdAt) || Date.now()
          };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pruneExpiredSessionSecretEntries(now = Date.now()) {
  const fresh = sessionSecretEntries.filter(
    entry => now - entry.createdAt <= SESSION_SECRET_RETENTION_MS
  );

  if (fresh.length === 0) {
    fresh.push({ secret: SESSION_SECRET, createdAt: now });
  }

  sessionSecretEntries.splice(0, sessionSecretEntries.length, ...fresh);
  syncSessionSecrets();
}

const sessionOptions = {
  name: 'agegate.sid',
  secret: sessionSecrets,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000
  },
  rolling: true
};

if (process.env.NODE_ENV !== 'test') {
  sessionOptions.store = new RedisSessionStore(redis);
}

let sessionSecretRotationTimer;

async function loadSessionSecrets() {
  try {
    const raw = await redis.get(SESSION_SECRETS_KEY);

    if (!raw) {
      pruneExpiredSessionSecretEntries();
      await redis.setex(
        SESSION_SECRETS_KEY,
        SESSION_SECRET_RETENTION_SECONDS,
        JSON.stringify(sessionSecretEntries)
      );
      return;
    }

    const parsed = normalizeSessionSecretEntries(raw)
      .filter(entry => Date.now() - entry.createdAt <= SESSION_SECRET_RETENTION_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SESSION_SECRET_HISTORY_LIMIT);

    if (parsed.length > 0) {
      sessionSecretEntries.splice(0, sessionSecretEntries.length, ...parsed);
      syncSessionSecrets();
      logger.info({ count: sessionSecrets.length }, 'Loaded session secrets');
      return;
    }

    pruneExpiredSessionSecretEntries();
    await redis.setex(
      SESSION_SECRETS_KEY,
      SESSION_SECRET_RETENTION_SECONDS,
      JSON.stringify(sessionSecretEntries)
    );
  } catch (err) {
    logger.error({ err }, 'Failed to load session secrets');
  }
}

async function rotateSessionSecret() {
  try {
    const newSecret = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    pruneExpiredSessionSecretEntries(now);

    const updated = [
      { secret: newSecret, createdAt: now },
      ...sessionSecretEntries
    ]
      .filter((entry, index, array) => array.findIndex(item => item.secret === entry.secret) === index)
      .filter(entry => now - entry.createdAt <= SESSION_SECRET_RETENTION_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SESSION_SECRET_HISTORY_LIMIT);

    await redis.setex(
      SESSION_SECRETS_KEY,
      SESSION_SECRET_RETENTION_SECONDS,
      JSON.stringify(updated)
    );

    sessionSecretEntries.splice(0, sessionSecretEntries.length, ...updated);
    syncSessionSecrets();
    logger.info('Session secret rotated');
  } catch (err) {
    logger.error({ err }, 'Session secret rotation failed');
  }
}

app.use(session(sessionOptions));

app.use((req, res, next) => {
  if (req.session && !req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(32).toString('hex');
  }
  next();
});

app.use(cookieParser());

// CSRF protection with double-submit cookie pattern (csrf-csrf)
const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: (req) => req.session?.csrfSecret || SESSION_SECRET,
  cookieName: "x-csrf-token",
  cookieOptions: {
    httpOnly: true,
    sameSite: "strict",
    secure: isHttps
  },
  size: 32,
  ignoredMethods: ["GET", "HEAD", "OPTIONS"],
  getSessionIdentifier: (req) => req.sessionID || 'anonymous',
  getCsrfTokenFromRequest: (req) => {
    return req.headers["x-csrf-token"] ||
           req.headers["csrf-token"] ||
           req.headers["CSRF-Token"] ||
           req.body["_csrf"];
  },
});

// Middleware to expose CSRF token to views (for meta tag and window.csrfToken)
const csrfTokenMiddleware = (req, res, next) => {
  res.locals.csrfToken = generateCsrfToken(req, res);
  next();
};

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

  // Check daily limit (if set)
  const dailyRes = await pool.query('SELECT daily_limit FROM api_keys WHERE api_key = $1', [apiKey]);
  const dailyLimit = dailyRes.rows[0]?.daily_limit;
  if (dailyLimit !== null && dailyLimit > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `daily:${apiKey}:${today}`;
    const dailyCount = await redis.get(dailyKey);
    const currentDaily = dailyCount ? parseInt(dailyCount) : 0;
    if (currentDaily >= dailyLimit) {
      logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Daily limit exceeded');
      return { allowed: false, type: 'daily', limit: dailyLimit };
    }
    // Increment daily counter (with TTL until midnight)
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const ttlSeconds = Math.ceil((midnight - now) / 1000);
    await redis.incr(dailyKey);
    if (ttlSeconds > 0) await redis.expire(dailyKey, ttlSeconds);
  }

  if (ttl === -1) await redis.expire(key, 60); // 1 minute window

  if (count > limit) {
    await redis.decr(key);
    return { allowed: false, type: 'rate', limit: limit };
  }
  return { allowed: true };
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
      daily_limit INTEGER DEFAULT NULL,
      is_active BOOLEAN DEFAULT true,
      stripe_customer_id TEXT,
      default_threshold INTEGER DEFAULT 18,
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

  // Webhooks table for client callbacks
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      client_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Client branding table (white-label)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_branding (
      client_id TEXT PRIMARY KEY,
      logo_url TEXT,
      primary_color VARCHAR(7) DEFAULT '#0f0',
      secondary_color VARCHAR(7) DEFAULT '#222',
      custom_domain TEXT,
      footer_text TEXT
    );
  `);

  // Plans table for subscription tiers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      stripe_price_id TEXT UNIQUE,
      rate_limit INTEGER NOT NULL,
      daily_limit INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      interval TEXT CHECK (interval IN ('month', 'year')),
      features JSONB
    );
  `);

  // Subscriptions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      client_id TEXT NOT NULL,
      stripe_subscription_id TEXT UNIQUE NOT NULL,
      plan_id INTEGER NOT NULL REFERENCES plans(id),
      status TEXT NOT NULL,
      current_period_end TIMESTAMPTZ NOT NULL,
      cancel_at_period_end BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Insert default plans if not exists
  const proPriceId = process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_pro_monthly';
  await pool.query(`
    INSERT INTO plans (name, stripe_price_id, rate_limit, daily_limit, price_cents, interval, features)
    VALUES
      ('Free', NULL, 100, 1000, 0, 'month', '{"webhooks": false, "agcom_export": false, "white_label": false}'),
      ('Pro', $1, 1000, 10000, 4900, 'month', '{"webhooks": true, "agcom_export": true, "white_label": false}'),
      ('Enterprise', NULL, 10000, 100000, 0, 'month', '{"webhooks": true, "agcom_export": true, "white_label": true}')
    ON CONFLICT (stripe_price_id) DO NOTHING;
  `, [proPriceId]);

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
  return req.session && req.session.adminUser ? req.session.adminUser : 'unknown';
}

// Admin auth helper
function isAdmin(req) {
  return Boolean(req.session && req.session.adminUser === ADMIN_USER);
}

// Helper to send webhook notification (fire and forget)
async function sendWebhook(clientId, verificationResult) {
  const result = await pool.query('SELECT url FROM webhooks WHERE client_id = $1', [clientId]);
  if (result.rows.length === 0) return;
  const url = result.rows[0].url;
  const payload = {
    event: 'verification.completed',
    client_id: clientId,
    verified: verificationResult.verified,
    threshold: verificationResult.threshold,
    timestamp: verificationResult.timestamp,
    proofType: verificationResult.proofType
  };
  // Use fetch (Node.js 18+) – don't await to avoid blocking
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(err => {
    logger.error({ err, clientId, url }, 'Webhook delivery failed');
  });
}

// Input validation schema
const verifySchema = z.object({
  client_id: z.string().min(3).max(100),
  threshold: z.number().int().min(18).max(25).default(18)
});

// Public registration page (self‑onboarding)
app.get('/register', csrfTokenMiddleware, (req, res) => {
  const csrfToken = res.locals.csrfToken;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Register – Age Gate as a Service</title>
    <style>
      body { font-family: system-ui; background: #111; color: #0f0; padding: 40px; text-align: center; }
      .card { background: #222; padding: 30px; border-radius: 12px; max-width: 500px; margin: 0 auto; }
      input, button { padding: 10px; margin: 8px; font-size: 16px; width: 90%; }
      button { background: #0f0; color: #111; border: none; border-radius: 8px; cursor: pointer; }
    </style>
    </head>
    <body>
      <div class="card">
        <h1>Get your API key</h1>
        <form method="POST" action="/api/v1/register/public">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
          <input type="text" name="client_id" placeholder="Client ID (e.g., yourdomain.com)" required><br>
          <input type="email" name="email" placeholder="Your email address" required><br>
          <input type="text" name="description" placeholder="Description (optional)"><br>
          <input type="number" name="threshold" value="18" min="18" max="25" placeholder="Threshold (18-25)"><br>
          <button type="submit">Register →</button>
        </form>
        <p><a href="/login">Admin login</a> | <a href="/">Back to home</a></p>
      </div>
    </body>
    </html>
  `);
});

// Public registration endpoint (self‑onboarding)
app.post('/api/v1/register/public', doubleCsrfProtection, async (req, res) => {
  const { client_id, email, description, threshold = 18 } = req.body;
  if (!client_id || !email) {
    return res.status(400).json({ error: 'client_id and email are required' });
  }

  // Rate limiting per email/IP to avoid abuse
  const rateKey = `self-register:${req.ip}`;
  const registerCount = await redis.get(rateKey);
  if (registerCount && parseInt(registerCount) >= 3) {
    return res.status(429).json({ error: 'Too many registration attempts. Try later.' });
  }
  await redis.incr(rateKey);
  await redis.expire(rateKey, 3600);

  // Check if client_id already exists
  const existing = await pool.query('SELECT client_id FROM api_keys WHERE client_id = $1', [client_id]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Client ID already registered. Contact support.' });
  }

  // Generate API key
  const randomBytes = crypto.randomBytes(24).toString('hex');
  const apiKey = `agk_${randomBytes}`;
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  // Insert into api_keys
  await pool.query(
    `INSERT INTO api_keys (client_id, api_key, expires_at, description, created_by, default_threshold)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [client_id, apiKey, expiresAt, description || null, 'self-service', threshold]
  );

  // Send email with API key
  if (emailTransporter) {
    const mailOptions = {
      from: FROM_EMAIL,
      to: email,
      subject: 'Your Age Gate API Key',
      text: `Hello,\n\nYou have successfully registered for Age Gate as a Service.\n\nYour API Key: ${apiKey}\nClient ID: ${client_id}\nExpires: ${expiresAt.toISOString()}\n\nUse this key in the x-api-key header.\n\nDashboard: ${process.env.PUBLIC_URL}/api/v1/client/dashboard\n\nThank you!`,
      html: `<p>Hello,</p><p>You have successfully registered for Age Gate as a Service.</p>
             <p><strong>API Key:</strong> ${apiKey}<br>
             <strong>Client ID:</strong> ${client_id}<br>
             <strong>Expires:</strong> ${expiresAt.toISOString()}</p>
             <p>Use this key in the <code>x-api-key</code> header.</p>
             <p>Dashboard: <a href="${process.env.PUBLIC_URL}/api/v1/client/dashboard">${process.env.PUBLIC_URL}/api/v1/client/dashboard</a></p>
            <p>Thank you!</p>`,
    };
    emailTransporter.sendMail(mailOptions).catch(err => logger.error({ err, email }, 'Failed to send registration email'));
  } else {
    logger.warn('SMTP not configured – email not sent');
  }

  res.json({
    success: true,
    message: 'Registration successful. API key has been sent to your email.',
    client_id,
    api_key: apiKey,
    expires_at: expiresAt
  });
});

// Simple rate limiter for self‑registration (per IP)
app.use('/api/v1/register/public', (req, res, next) => {
  // Already handled inside the route, but we can add a global middleware if needed
  next();
});

// Nice HTML login page
app.get('/login', csrfTokenMiddleware, (req, res) => {
  const csrfToken = res.locals.csrfToken
  const error = req.query.error === 'invalid'
    ? '<p style="color:#f66">Invalid credentials</p>'
    : '';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>AgeGate Login</title></head>
    <body style="font-family:system-ui;background:#111;color:#0f0;padding:40px;text-align:center">
      <h1>Age Gate Admin Login</h1>
      ${error}
      <form method="POST" action="/login">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input id="user" name="user" placeholder="Username"><br><br>
        <input id="pass" name="pass" type="password" placeholder="Password"><br><br>
        <button type="submit">Login</button>
      </form>
    </body>
    </html>
  `);
});

app.post('/login', doubleCsrfProtection, (req, res) => {
  const { user, pass } = req.body;

  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    return res.redirect('/login?error=invalid');
  }

  req.session.regenerate((err) => {
    if (err) {
      logger.error({ err }, 'Session regeneration failed during login');
      return res.status(500).send('Login failed');
    }

    req.session.adminUser = user;
    req.session.loginAt = Date.now();

    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error({ saveErr }, 'Session save failed during login');
        return res.status(500).send('Login failed');
      }

      return res.redirect('/dashboard');
    });
  });
});

// Verifier
app.post('/api/v1/verify', async (req, res) => {
  const start = Date.now();
  const apiKey = req.headers['x-api-key'];
  const clientId = req.body.client_id || 'unknown';
  let threshold = req.body.threshold !== undefined ? parseInt(req.body.threshold) : null;

  if (!apiKey) {
    logger.warn({ clientId }, 'Missing API Key');
    return res.status(401).json({ status: 'error', message: 'Missing API Key' });
  }

  // Validate API key: exists, active, not expired
  const keyCheck = await pool.query(
    `SELECT client_id, expires_at, is_active, default_threshold FROM api_keys WHERE api_key = $1`,
    [apiKey]
  );

  if (keyCheck.rows.length === 0 || !keyCheck.rows[0].is_active) {
    logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Invalid or revoked API key');
    return res.status(401).json({ status: 'error', message: 'Invalid API key' });
  }
  const keyRecord = keyCheck.rows[0];

  // Zod validation
  try {
    verifySchema.parse(req.body);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: 'Invalid input', details: err.errors });
  }

  // Use request threshold if provided, otherwise fallback to client's default_threshold
  if (threshold === null) {
    threshold = keyRecord.default_threshold || 18;
  }
  // Validate only once
  if (threshold < 18 || threshold > 25) {
    return res.status(400).json({ status: 'error', message: 'Threshold must be between 18 and 25' });
  }

  const rateCheck = await checkRateLimit(req, apiKey);
  if (!rateCheck.allowed) {
    if (rateCheck.type === 'daily') {
      logger.warn({ apiKey: apiKey.substring(0,8)+'...' }, 'Daily limit exceeded');
      rateLimitedCounter.inc({ client_id: clientId, type: 'daily' });
      return res.status(429).json({ status: 'error', message: `Daily limit exceeded (${rateCheck.limit} verifications/day)` });
    } else {
      // rate limit
      logger.warn({ apiKey: apiKey.substring(0,8)+'...', anonymizedIP: req.anonymizedIP }, 'Rate limit exceeded');
      rateLimitedCounter.inc({ client_id: clientId, type: 'rate' });
      return res.status(429).json({ status: 'error', message: `Rate limit exceeded (${rateCheck.limit} requests/min)` });
    }
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
      // realistic simulation for testing, but force verified in integration tests
      if (process.env.FORCE_VERIFIED === 'true') {
        verified = true;
      } else {
        verified = Math.random() * 100 >= (threshold - 5);
      }
    } else if (backend === 'eidas') {
      // TODO: OID4VP / mDoc integration (future)
      verified = true; // placeholder
    }

    const timestamp = new Date().toISOString();
    await pool.query(
      `INSERT INTO verifications (client_id, api_key, threshold, timestamp, verified) VALUES ($1, $2, $3, $4, $5)`,
      [clientId, apiKey, threshold, timestamp, verified]
    );

    // Send webhook asynchronously (fire and forget)
    sendWebhook(clientId, { verified, threshold, timestamp, proofType: backend === 'eidas' ? 'eIDAS2.0' : 'mock' });

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

// GET /api/v1/stats - Client statistics (authenticated via API key)
app.get('/api/v1/stats', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    logger.warn({ clientId: 'unknown' }, 'Missing API Key for stats');
    return res.status(401).json({ status: 'error', message: 'Missing API Key' });
  }

  // Validate API key: exists, active, not expired
  const keyCheck = await pool.query(
    `SELECT client_id, expires_at, is_active, default_threshold FROM api_keys WHERE api_key = $1`,
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
  if (!(await checkRateLimit(req, apiKey)).allowed) {
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

  // Threshold breakdown
  const thresholdResult = await pool.query(
    `SELECT threshold, COUNT(*) as count
     FROM verifications
     WHERE client_id = $1 AND api_key = $2
     GROUP BY threshold
     ORDER BY threshold`,
    [clientId, apiKey]
  );
  const thresholdBreakdown = thresholdResult.rows.map(row => ({
    threshold: row.threshold,
    count: parseInt(row.count)
  }));

  // Weekly breakdown (last 12 weeks)
  const weeklyResult = await pool.query(
    `SELECT DATE_TRUNC('week', timestamp) as week, COUNT(*) as count
     FROM verifications
     WHERE client_id = $1 AND api_key = $2
       AND timestamp > NOW() - INTERVAL '12 weeks'
     GROUP BY week
     ORDER BY week DESC`,
    [clientId, apiKey]
  );
  const weeklyBreakdown = weeklyResult.rows.map(row => ({
    week: row.week.toISOString().slice(0,10),
    verifications: parseInt(row.count)
  }));

  res.json({
    client_id: clientId,
    total_verifications: total,
    successful_verifications: successful,
    success_rate: parseFloat(successRate),
    last_verification: lastVerification,
    daily_breakdown: daily,
    threshold_breakdown: thresholdBreakdown,
    weekly_breakdown: weeklyBreakdown
  });
});

// GET /api/v1/branding/:client_id - Public endpoint for white-label branding
app.get('/api/v1/branding/:client_id', async (req, res) => {
  const { client_id } = req.params;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const result = await pool.query(
    `SELECT logo_url, primary_color, secondary_color, custom_domain, footer_text
     FROM client_branding
     WHERE client_id = $1`,
    [client_id]
  );
  if (result.rows.length === 0) {
    // Return default branding
    return res.json({
      client_id,
      logo_url: null,
      primary_color: '#0f0',
      secondary_color: '#222',
      custom_domain: null,
      footer_text: null
    });
  }
  res.json({
    client_id,
    ...result.rows[0]
  });
});

// Helper function to get stats for a client (reused by client dashboard)
async function getStatsForClient(apiKey) {
  const keyCheck = await pool.query(
    `SELECT client_id FROM api_keys WHERE api_key = $1 AND is_active = true`,
    [apiKey]
  );
  if (keyCheck.rows.length === 0) return null;
  const clientId = keyCheck.rows[0].client_id;

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

  const lastResult = await pool.query(
    `SELECT MAX(timestamp) as last FROM verifications WHERE client_id = $1 AND api_key = $2`,
    [clientId, apiKey]
  );
  const lastVerification = lastResult.rows[0].last;

  return { total_verifications: total, successful_verifications: successful, success_rate: parseFloat(successRate), last_verification: lastVerification };
}

// Client self-service dashboard (HTML)
app.get('/api/v1/client/dashboard', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).send('Missing API Key');
  }
  // Verify API key
  const keyCheck = await pool.query(
    `SELECT client_id, is_active, expires_at FROM api_keys WHERE api_key = $1`,
    [apiKey]
  );
  if (keyCheck.rows.length === 0 || !keyCheck.rows[0].is_active) {
    return res.status(401).send('Invalid or revoked API key');
  }
  if (keyCheck.rows[0].expires_at && new Date(keyCheck.rows[0].expires_at) < new Date()) {
    return res.status(401).send('API key expired');
  }
  const clientId = keyCheck.rows[0].client_id;

  const statsRes = await getStatsForClient(apiKey);

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AgeGate Client Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: system-ui; background: #111; color: #0f0; padding: 20px; }
    .card { background: #222; padding: 20px; border-radius: 12px; margin: 15px 0; }
    .chart-container { width: 100%; max-width: 600px; margin: 20px auto; }
    canvas { max-height: 300px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; border: 1px solid #0a0; text-align: left; }
    input, button { padding: 10px; margin: 5px; font-size: 16px; }
  </style>
</head>
<body>
  <h1>Age Gate Client Dashboard</h1>
  <div class="card">
    <h2>Your Statistics</h2>
    <p>Client ID: <strong>${clientId}</strong></p>
    <p>Total verifications: <strong>${statsRes.total_verifications}</strong></p>
    <p>Successful verifications: <strong>${statsRes.successful_verifications}</strong></p>
    <p>Success rate: <strong>${statsRes.success_rate}%</strong></p>
    <p>Last verification: <strong>${statsRes.last_verification ? new Date(statsRes.last_verification).toLocaleString() : 'never'}</strong></p>
  </div>
  <div class="card"><h2>Daily Verifications (last 30 days)</h2><div class="chart-container"><canvas id="dailyChart"></canvas></div></div>
  <div class="card"><h2>Verifications by Threshold</h2><div class="chart-container"><canvas id="thresholdChart"></canvas></div></div>
  <div class="card"><h2>Weekly Verifications (last 12 weeks)</h2><div class="chart-container"><canvas id="weeklyChart"></canvas></div></div>
  <div class="card">
    <h2>Your Subscription Plan</h2>
    <div id="subscriptionInfo">Loading...</div>
    <div id="upgradeButton"></div>
  </div>
  <div class="card">
    <h2>Manage Your API Key</h2>
    <button onclick="rotateKey()">Rotate API Key</button>
    <button onclick="updateDescription()">Update Description</button>
  </div>
  <div class="card">
    <h2>Current Description</h2>
    <p id="currentDescription">Loading...</p>
  </div>
  <script>
    async function loadDescription() {
      const response = await fetch('/api/v1/client/description', {
        headers: { 'x-api-key': '${apiKey}' }
      });
      if (response.ok) {
        const data = await response.json();
        document.getElementById('currentDescription').innerText = data.description || '(none)';
      }
    }
    async function loadCharts() {
      const response = await fetch('/api/v1/stats', {
        headers: { 'x-api-key': '${apiKey}' }
      });
      if (response.ok) {
        const data = await response.json();
        // Daily chart (line)
        const dailyLabels = data.daily_breakdown.map(d => d.date).reverse();
        const dailyCounts = data.daily_breakdown.map(d => d.verifications).reverse();
        new Chart(document.getElementById('dailyChart'), {
          type: 'line',
          data: { labels: dailyLabels, datasets: [{ label: 'Verifications', data: dailyCounts, borderColor: '#0f0', fill: false }] },
          options: { responsive: true, maintainAspectRatio: true }
        });
        // Threshold pie chart
        const thresholdLabels = data.threshold_breakdown.map(t => t.threshold);
        const thresholdCounts = data.threshold_breakdown.map(t => t.count);
        new Chart(document.getElementById('thresholdChart'), {
          type: 'pie',
          data: { labels: thresholdLabels, datasets: [{ data: thresholdCounts, backgroundColor: ['#0f0', '#0a0', '#050'] }] }
        });
        // Weekly bar chart
        const weeklyLabels = data.weekly_breakdown.map(w => w.week).reverse();
        const weeklyCounts = data.weekly_breakdown.map(w => w.verifications).reverse();
        new Chart(document.getElementById('weeklyChart'), {
          type: 'bar',
          data: { labels: weeklyLabels, datasets: [{ label: 'Verifications', data: weeklyCounts, backgroundColor: '#0f0' }] }
        });
      } else {
        console.error('Failed to load stats for charts');
      }
    }
    // Ensure Chart is defined before loading
    if (typeof Chart !== 'undefined') {
      loadCharts();
    } else {
      window.addEventListener('load', () => {
        loadCharts();
      });
    }
    async function rotateKey() {
      if (!confirm('Generate a new API key? The old one will be revoked immediately.')) return;
      const response = await fetch('/api/v1/client/rotate', {
        method: 'POST',
        headers: { 'x-api-key': '${apiKey}' }
      });
      if (response.ok) {
        const data = await response.json();
        alert('New API Key: ' + data.api_key + '\\nPlease save it. The page will reload.');
        location.reload();
      } else {
        alert('Rotation failed');
      }
    }
    async function updateDescription() {
      const newDesc = prompt('Enter new description:');
      if (newDesc === null) return;
      const response = await fetch('/api/v1/client/description', {
        method: 'PATCH',
        headers: { 'x-api-key': '${apiKey}', 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: newDesc })
      });
      if (response.ok) {
        alert('Description updated');
        loadDescription();
      } else {
        alert('Update failed');
      }
    }

    async function loadSubscription() {
      try {
        const response = await fetch('/api/v1/client/subscription', {
          headers: { 'x-api-key': '${apiKey}' }
        });
        if (response.ok) {
          const data = await response.json();
          let infoHtml = '<p>Plan: <strong>' + data.plan_name + '</strong></p>' +
                         '<p>Rate limit: ' + data.rate_limit + ' req/min</p>' +
                         '<p>Daily limit: ' + data.daily_limit + ' verifications/day</p>';
          if (data.status === 'active') {
            infoHtml += '<p>Next billing: ' + new Date(data.current_period_end).toLocaleDateString() + '</p>';
          }
          document.getElementById('subscriptionInfo').innerHTML = infoHtml;
          const upgradeDiv = document.getElementById('upgradeButton');
          if (data.plan_name === 'Free') {
            upgradeDiv.innerHTML = '<button onclick="upgradePlan()">Upgrade to Pro</button>';
          } else if (data.portal_url) {
            upgradeDiv.innerHTML = '<a href="' + data.portal_url + '" target="_blank" class="btn">Manage subscription</a>';
          }
        } else {
          document.getElementById('subscriptionInfo').innerText = 'Unable to load subscription details.';
        }
      } catch (err) {
        console.error('Failed to load subscription:', err);
      }
    }

    async function upgradePlan() {
      const plansRes = await fetch('/api/v1/plans');
      const plans = await plansRes.json();
      const proPlan = plans.find(p => p.name === 'Pro');
      if (!proPlan || !proPlan.stripe_price_id) {
        alert('Pro plan not configured');
        return;
      }
      const response = await fetch('/api/v1/stripe/create-checkout-session', {
        method: 'POST',
        headers: { 'x-api-key': '${apiKey}', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId: proPlan.stripe_price_id,
          successUrl: window.location.href,
          cancelUrl: window.location.href
        })
      });
      const data = await response.json();
      if (data.url) window.location.href = data.url;
      else alert('Failed to create checkout session');
    }

    // Call loadSubscription after loadDescription
    loadDescription();
    loadSubscription();
  </script>
</body>
</html>`;
  res.send(html);
});

// Client endpoint to get description
app.get('/api/v1/client/description', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });
  const result = await pool.query('SELECT description FROM api_keys WHERE api_key = $1', [apiKey]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'API key not found' });
  res.json({ description: result.rows[0].description });
});

// Client endpoint to update description
app.patch('/api/v1/client/description', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });
  const { description } = req.body;
  if (typeof description !== 'string') return res.status(400).json({ error: 'description must be a string' });
  await pool.query('UPDATE api_keys SET description = $1 WHERE api_key = $2', [description.trim().slice(0, 255), apiKey]);
  res.json({ success: true, description });
});

// Client endpoint to rotate API key
app.post('/api/v1/client/rotate', async (req, res) => {
  const oldApiKey = req.headers['x-api-key'];
  if (!oldApiKey) return res.status(401).json({ error: 'Missing API Key' });
  // Get client_id and verify key is active
  const keyCheck = await pool.query(
    `SELECT client_id, is_active, expires_at FROM api_keys WHERE api_key = $1`,
    [oldApiKey]
  );
  if (keyCheck.rows.length === 0 || !keyCheck.rows[0].is_active) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }
  const clientId = keyCheck.rows[0].client_id;
  // Generate new key
  const randomBytes = crypto.randomBytes(24).toString('hex');
  const newApiKey = `agk_${randomBytes}`;
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  await pool.query('BEGIN');
  await pool.query('UPDATE api_keys SET is_active = false WHERE api_key = $1', [oldApiKey]);
  await pool.query('INSERT INTO api_keys (client_id, api_key, expires_at, created_by) VALUES ($1, $2, $3, $4)', [clientId, newApiKey, expiresAt, 'self-service']);
  await pool.query('COMMIT');
  res.json({ client_id: clientId, api_key: newApiKey, expires_at: expiresAt });
});

// Dashboard
app.get('/dashboard', async (req, res) => {
  if (!isAdmin(req)) {
    return res.redirect('/login');
  }

  // Fetch API keys with status
  const keys = await pool.query(`
    SELECT client_id, api_key, created_at, expires_at, last_used_at, is_active, description, rate_limit, daily_limit
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

  // Generate CSRF token for the dashboard (exposed to frontend)
  const csrfToken = generateCsrfToken(req, res) || '';

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
  <meta name="csrf-token" content="${escapeHtml(csrfToken)}">
<script>
    window.csrfToken = ${JSON.stringify(csrfToken)};

    // Funzione per aggiornare il token CSRF prima di ogni azione sensibile
    async function refreshCsrfToken() {
      try {
        const res = await fetch('/csrf-token');
        const data = await res.json();
        window.csrfToken = data.csrfToken;
      } catch(e) {
        console.error('Failed to refresh CSRF token');
      }
    }
  </script>
  <script>
    // Define functions before any button uses them
    async function registerClient() {
      const clientId = document.getElementById('newClientId').value.trim();
      const description = document.getElementById('newClientDesc').value.trim();
      if (!clientId) return alert('Client ID is required');
      await refreshCsrfToken();
      const response = await fetch('/api/v1/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
        body: JSON.stringify({ client_id: clientId, description: description || undefined })
      });
      const data = await response.json();
      alert('API Key generated: ' + data.api_key + (data.expires_at ? '\\nExpires: ' + new Date(data.expires_at).toLocaleString() : ''));
      location.reload();
    }

    async function revokeKey(apiKey) {
      if (!confirm('Revoke this API Key permanently?')) return;
      await refreshCsrfToken();
      const response = await fetch('/api/v1/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
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
      await refreshCsrfToken();
      const response = await fetch('/api/v1/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
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
        const response = await fetch('/api/v1/stats', {
          method: 'GET',
          headers: { 'x-api-key': apiKey, 'CSRF-Token': window.csrfToken }
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
      await refreshCsrfToken();
      const response = await fetch('/api/v1/keys/' + apiKey + '/rate-limit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
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

    async function editDailyLimit(apiKey, currentLimit) {
      let newLimit = prompt('Enter daily limit (positive integer) or leave empty for unlimited:', currentLimit === 'null' ? '' : currentLimit);
      if (newLimit === null) return;
      let dailyLimit = null;
      if (newLimit.trim() !== '') {
        const limitNum = parseInt(newLimit, 10);
        if (isNaN(limitNum) || limitNum < 1) {
          alert('Daily limit must be a positive integer');
          return;
        }
        dailyLimit = limitNum;
      }
      await refreshCsrfToken();
      const response = await fetch('/api/v1/keys/' + apiKey + '/daily-limit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
        body: JSON.stringify({ daily_limit: dailyLimit })
      });
      if (response.ok) location.reload();
      else alert('Failed to update daily limit');
    }

    async function editDescription(apiKey, currentDesc) {
      const newDesc = prompt('Enter new description:', currentDesc);
      if (newDesc === null) return;
      await refreshCsrfToken();
      const response = await fetch('/api/v1/keys/' + apiKey + '/description', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
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
      <th>Client</th><th>API Key</th><th>Description</th><th>Rate Limit</th><th>Daily Limit</th><th>Created</th><th>Expires</th><th>Last Used</th><th>Success Rate</th><th>Status</th><th>Actions</th><th>Stats</th>`;

  keys.rows.forEach(k => {
    const successRate = rateMap[k.client_id] || '0';
    const safeDesc = (k.description || '').replace(/'/g, "\\'");

    html += `<tr>
      <td>${k.client_id}</td>
      <td><code>${k.api_key.substring(0,12)}...</code></td>
      <td>${k.description || '-'}</td>
      <td id="rate-limit-${k.api_key}">${k.rate_limit}</td>
      <td id="daily-limit-${k.api_key}">${k.daily_limit !== null ? k.daily_limit : '∞'}</td>
      <td>${new Date(k.created_at).toLocaleString()}</td>
      <td>${k.expires_at ? new Date(k.expires_at).toLocaleString() : 'never'}</td>
      <td>${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
      <td>${successRate}%</td>
      <td>${k.is_active ? '✅ active' : '❌ revoked'}</td>
      <td>
         ${k.is_active ? `<button onclick="rotateKey('${k.api_key}')">Rotate</button>` : ''}
         <button onclick="editRateLimit('${k.api_key}', ${k.rate_limit})">Edit Rate</button>
         <button onclick="editDailyLimit('${k.api_key}', ${k.daily_limit !== null ? k.daily_limit : 'null'})">Edit Daily</button>
         <button onclick="revokeKey('${k.api_key}')">Revoke</button>
	 <button onclick="editDescription('${k.api_key}', '${safeDesc}')">Edit Desc</button>
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
      <td>${escapeHtml(log.admin_user)}</td>
      <td>${escapeHtml(log.action)}</td>
      <td>${escapeHtml(log.target || '-')}</td>
      <td>${escapeHtml(JSON.stringify(log.details))}</td>
      <td>${new Date(log.timestamp).toLocaleString()}</td>
    </tr>`;
  });
  html += `</table>
  </div>

  <div class="card">
    <h2>Webhook Management</h2>
    <button onclick="showAddWebhook()">Add Webhook</button>
    <table id="webhooksTable">
      <thead>
        <tr><th>Client ID</th><th>URL</th><th>Created</th><th>Updated</th><th>Actions</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <script>
    async function loadWebhooks() {
      const response = await fetch('/api/v1/webhooks', {
        headers: { 'CSRF-Token': window.csrfToken }
      });
      if (response.ok) {
        const data = await response.json();
        const tbody = document.querySelector('#webhooksTable tbody');
        tbody.innerHTML = '';
        for (const w of data.webhooks) {
          const row = tbody.insertRow();
          row.insertCell(0).innerText = w.client_id;
          row.insertCell(1).innerText = w.url;
          row.insertCell(2).innerText = new Date(w.created_at).toLocaleString();
          row.insertCell(3).innerText = new Date(w.updated_at).toLocaleString();
          const actionsCell = row.insertCell(4);
          const deleteBtn = document.createElement('button');
          deleteBtn.innerText = 'Delete';
          deleteBtn.onclick = () => deleteWebhook(w.client_id);
          actionsCell.appendChild(deleteBtn);
        }
      }
    }

    async function showAddWebhook() {
      const clientId = prompt('Enter client ID:');
      if (!clientId) return;
      const url = prompt('Enter webhook URL (https://...):');
      if (!url) return;
      await refreshCsrfToken();
      const response = await fetch('/api/v1/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
        body: JSON.stringify({ client_id: clientId, url })
      });
      if (response.ok) {
        alert('Webhook added/updated');
        loadWebhooks();
      } else {
        alert('Failed to add webhook');
      }
    }

    async function deleteWebhook(clientId) {
      if (!confirm('Delete webhook for ' + clientId + '?')) return;
      await refreshCsrfToken();
      const response = await fetch('/api/v1/webhook/' + clientId, {
        method: 'DELETE',
        headers: { 'CSRF-Token': window.csrfToken }
      });
      if (response.ok) {
        alert('Webhook deleted');
        loadWebhooks();
      } else {
        alert('Failed to delete webhook');
      }
    }

    // Load webhooks when page loads
    loadWebhooks();
  </script>

  <div class="card">
    <h2>AGCOM Compliance Export</h2>
    <label>Format:</label>
    <select id="exportFormat">
      <option value="csv">CSV</option>
      <option value="pdf">PDF</option>
    </select>
    <label>Client ID (optional):</label>
    <input type="text" id="exportClientId" placeholder="Leave empty for all">
    <label>From date (YYYY-MM-DD):</label>
    <input type="date" id="exportFrom">
    <label>To date (YYYY-MM-DD):</label>
    <input type="date" id="exportTo">
    <button onclick="exportCompliance()">Export Report</button>
  </div>

  <script>
    async function exportCompliance() {
      const format = document.getElementById('exportFormat').value;
      const clientId = document.getElementById('exportClientId').value.trim();
      const from = document.getElementById('exportFrom').value;
      const to = document.getElementById('exportTo').value;
      let url = '/api/v1/export/compliance?format=' + format;
      if (clientId) url += '&client_id=' + encodeURIComponent(clientId);
      if (from) url += '&from=' + from;
      if (to) url += '&to=' + to;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'CSRF-Token': window.csrfToken }
      });
      if (response.ok) {
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'agcom_export.' + format;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(downloadUrl);
      } else {
        alert('Export failed');
      }
    }
  </script>

  <div class="card">
    <h2>All Client Brandings</h2>
    <table id="brandingTable">
      <thead>
        <tr><th>Client ID</th><th>Logo URL</th><th>Primary Color</th><th>Secondary Color</th><th>Actions</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <script>
    async function loadBrandingList() {
      const response = await fetch('/api/v1/branding', {
        headers: { 'CSRF-Token': window.csrfToken }
      });
      if (response.ok) {
        const data = await response.json();
        const tbody = document.querySelector('#brandingTable tbody');
        tbody.innerHTML = '';
        for (const b of data.branding) {
          const row = tbody.insertRow();
          row.insertCell(0).innerText = b.client_id;
          row.insertCell(1).innerText = b.logo_url || '-';
          row.insertCell(2).innerHTML = '<span style="background:' + b.primary_color + '; padding:2px 8px; border-radius:4px; color:#000;">' + b.primary_color + '</span>';
          row.insertCell(3).innerHTML = '<span style="background:' + b.secondary_color + '; padding:2px 8px; border-radius:4px; color:#000;">' + b.secondary_color + '</span>';
          const actionsCell = row.insertCell(4);
          const editBtn = document.createElement('button');
          editBtn.innerText = 'Edit';
          editBtn.onclick = () => loadBrandingForEdit(b.client_id);
          const deleteBtn = document.createElement('button');
          deleteBtn.innerText = 'Delete';
          deleteBtn.onclick = () => deleteBranding(b.client_id);
          actionsCell.appendChild(editBtn);
          actionsCell.appendChild(deleteBtn);
        }
      }
    }
  </script>

  <div class="card">
    <h2>Client Branding (White‑Label)</h2>
    <label>Client ID:</label>
    <select id="brandingClientId">
      <option value="">-- Select a client --</option>
      ${keys.rows.map(k => `<option value="${k.client_id}">${k.client_id}</option>`).join('')}
    </select>
    <button onclick="loadBranding()">Load</button>
    <div id="brandingForm" style="display:none; margin-top:15px;">
      <label>Logo URL:</label>
      <input type="text" id="logoUrl" placeholder="https://example.com/logo.png"><br>
      <label>Primary Color (hex):</label>
      <input type="color" id="primaryColor" value="#0f0"><br>
      <label>Secondary Color (hex):</label>
      <input type="color" id="secondaryColor" value="#222"><br>
      <label>Custom Domain:</label>
      <input type="text" id="customDomain" placeholder="verify.client.com"><br>
      <label>Footer Text:</label>
      <input type="text" id="footerText" placeholder="Powered by AgeGate"><br>
      <button onclick="saveBranding()">Save Branding</button>
    </div>
  </div>

  <script>
    async function loadBranding() {
      const clientId = document.getElementById('brandingClientId').value;
      if (!clientId) return;
      const response = await fetch('/api/v1/branding/admin/' + clientId, {
        headers: { 'CSRF-Token': window.csrfToken }
      });
      if (response.ok) {
        const data = await response.json();
        document.getElementById('logoUrl').value = data.logo_url || '';
        document.getElementById('primaryColor').value = data.primary_color || '#0f0';
        document.getElementById('secondaryColor').value = data.secondary_color || '#222';
        document.getElementById('customDomain').value = data.custom_domain || '';
        document.getElementById('footerText').value = data.footer_text || '';
        document.getElementById('brandingForm').style.display = 'block';
      } else {
        alert('Failed to load branding');
      }
    }

    async function saveBranding() {
      const clientId = document.getElementById('brandingClientId').value;
      const payload = {
        client_id: clientId,
        logo_url: document.getElementById('logoUrl').value,
        primary_color: document.getElementById('primaryColor').value,
        secondary_color: document.getElementById('secondaryColor').value,
        custom_domain: document.getElementById('customDomain').value,
        footer_text: document.getElementById('footerText').value
      };
      const response = await fetch('/api/v1/branding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CSRF-Token': window.csrfToken },
        body: JSON.stringify(payload)
      });
      if (response.ok) alert('Branding saved');
      else alert('Failed to save branding');
    }

    async function loadBrandingForEdit(clientId) {
      const response = await fetch('/api/v1/branding/admin/' + clientId, {
        headers: { 'CSRF-Token': window.csrfToken }
      });
      if (response.ok) {
        const data = await response.json();
        document.getElementById('brandingClientId').value = data.client_id;
        document.getElementById('logoUrl').value = data.logo_url || '';
        document.getElementById('primaryColor').value = data.primary_color || '#0f0';
        document.getElementById('secondaryColor').value = data.secondary_color || '#222';
        document.getElementById('customDomain').value = data.custom_domain || '';
        document.getElementById('footerText').value = data.footer_text || '';
        document.getElementById('brandingForm').style.display = 'block';
        const select = document.getElementById('brandingClientId');
        select.value = data.client_id;
      } else {
        alert('Failed to load branding');
      }
    }

    async function deleteBranding(clientId) {
      if (!confirm('Delete branding for ' + clientId + '?')) return;
      const response = await fetch('/api/v1/branding/' + clientId, {
        method: 'DELETE',
        headers: { 'CSRF-Token': window.csrfToken }
      });
      if (response.ok) {
       alert('Branding deleted');
        loadBrandingList();
        if (document.getElementById('brandingClientId').value === clientId) {
          document.getElementById('brandingForm').style.display = 'none';
        }
      } else {
        alert('Failed to delete branding');
      }
    }

    // Load branding list when dashboard loads
    loadBrandingList();
  </script>

  <a href="/logout">Logout</a>
</body>
</html>`;
  res.send(html);
});

// CSRF token endpoint for browser and tests
app.get('/csrf-token', (req, res) => {
  const csrfToken = generateCsrfToken(req, res);
  res.json({ csrfToken });
});

// Admin endpoints
app.post('/api/v1/register', doubleCsrfProtection, (req, res) => {
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

app.post('/api/v1/revoke', doubleCsrfProtection, async (req, res) => {
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
app.post('/api/v1/rotate', doubleCsrfProtection, async (req, res) => {
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

// PATCH /api/v1/keys/:api_key/rate-limit - Update rate limit for an API key (admin only)
app.patch('/api/v1/keys/:api_key/rate-limit', doubleCsrfProtection, async (req, res) => {
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

// PATCH /api/v1/keys/:api_key/daily-limit - Update daily limit for an API key (admin only)
app.patch('/api/v1/keys/:api_key/daily-limit', doubleCsrfProtection, async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { api_key } = req.params;
  const { daily_limit } = req.body;
  if (daily_limit !== null && (!Number.isInteger(daily_limit) || daily_limit < 1)) {
    return res.status(400).json({ error: 'daily_limit must be a positive integer or null' });
  }
  const result = await pool.query(
    'UPDATE api_keys SET daily_limit = $1 WHERE api_key = $2 RETURNING client_id',
    [daily_limit, api_key]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'API key not found' });
  }
  const adminUser = getAdminUser(req);
  await logAdminAction(adminUser, 'UPDATE_DAILY_LIMIT', api_key, { daily_limit });
  res.json({ success: true, client_id: result.rows[0].client_id, daily_limit });
});

// PATCH /api/v1/keys/:api_key/description - Update description for an API key (admin only)
app.patch('/api/v1/keys/:api_key/description', doubleCsrfProtection, async (req, res) => {
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

// GET /api/v1/webhooks - List all webhooks (admin only)
app.get('/api/v1/webhooks', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query('SELECT client_id, url, created_at, updated_at FROM webhooks ORDER BY client_id');
  res.json({ webhooks: result.rows });
});

// Webhook management endpoint (admin only)
app.post('/api/v1/webhook', doubleCsrfProtection, async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id, url } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url must be a string' });
  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  await pool.query(
    `INSERT INTO webhooks (client_id, url, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (client_id) DO UPDATE SET url = EXCLUDED.url, updated_at = NOW()`,
    [client_id, url]
  );
  const adminUser = getAdminUser(req);
  await logAdminAction(adminUser, 'SET_WEBHOOK', client_id, { url });
  res.json({ success: true, client_id, url });
});

// Optional: DELETE /api/v1/webhook/:client_id to remove webhook
app.delete('/api/v1/webhook/:client_id', doubleCsrfProtection, async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id } = req.params;
  await pool.query('DELETE FROM webhooks WHERE client_id = $1', [client_id]);
  const adminUser = getAdminUser(req);
  await logAdminAction(adminUser, 'DELETE_WEBHOOK', client_id, {});
  res.json({ success: true, client_id });
});

// GET /api/v1/export/compliance - Export verifications for AGCOM (admin only)
app.get('/api/v1/export/compliance', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { format, from, to, client_id } = req.query;
  if (!['csv', 'pdf'].includes(format)) {
    return res.status(400).json({ error: 'format must be csv or pdf' });
  }

  let query = `
    SELECT
      client_id,
      DATE(timestamp) as date,
      COUNT(*) as total_verifications,
      SUM(CASE WHEN verified THEN 1 ELSE 0 END) as successful,
      AVG(threshold) as avg_threshold
    FROM verifications
    WHERE 1=1
  `;
  const params = [];
  if (client_id) {
    params.push(client_id);
    query += ` AND client_id = $${params.length}`;
  }
  if (from) {
    params.push(from);
    query += ` AND timestamp >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    query += ` AND timestamp <= $${params.length}`;
  }
  query += ` GROUP BY client_id, DATE(timestamp) ORDER BY date DESC, client_id`;

  const result = await pool.query(query, params);
  const rows = result.rows;

  if (format === 'csv') {
    // Generate CSV
    const csvData = rows.map(row => ({
      client_id: row.client_id,
      date: row.date.toISOString().slice(0,10),
      total_verifications: row.total_verifications,
      successful: row.successful,
      success_rate: row.total_verifications > 0 ? (row.successful / row.total_verifications * 100).toFixed(2) : 0,
      avg_threshold: parseFloat(row.avg_threshold).toFixed(1)
    }));
    const header = ['client_id','date','total_verifications','successful','success_rate','avg_threshold'];
    const csv = [header.join(',')];
    for (const row of csvData) {
      csv.push(header.map(h => JSON.stringify(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="agcom_export.csv"');
    return res.send(csv.join('\n'));
  } else if (format === 'pdf') {
    // Generate PDF
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="agcom_export.pdf"');
    doc.pipe(res);
    doc.fontSize(18).text('AGCOM Compliance Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown();
    if (client_id) doc.text(`Client ID: ${client_id}`);
    if (from) doc.text(`From: ${from}`);
    if (to) doc.text(`To: ${to}`);
    doc.moveDown();

    if (rows.length === 0) {
      doc.text('No data available for the selected criteria.', 50, doc.y);
      doc.end();
      return;
    }

    // Define table columns with fixed widths
    const colDefs = [
      { header: 'Client ID', width: 100, align: 'left', getter: (r) => r.client_id },
      { header: 'Date', width: 80, align: 'left', getter: (r) => r.date.toISOString().slice(0,10) },
      { header: 'Total', width: 50, align: 'right', getter: (r) => r.total_verifications },
      { header: 'Successful', width: 70, align: 'right', getter: (r) => r.successful },
      { header: 'Success Rate', width: 80, align: 'right', getter: (r) =>
        r.total_verifications > 0 ? ((r.successful / r.total_verifications) * 100).toFixed(2) + '%' : '0%' },
      { header: 'Avg Threshold', width: 80, align: 'right', getter: (r) => parseFloat(r.avg_threshold).toFixed(1) }
    ];

    const tableTop = doc.y;
    const rowHeight = 18;
    const headerHeight = 20;
    const startX = 50;
    let x = startX;

    // Draw header background (light gray) and ensure text is black
    doc.fillColor('#dddddd').rect(startX, tableTop, 500, headerHeight).fill();
    doc.fillColor('black');
    doc.font('Helvetica-Bold').fontSize(9);
    x = startX;
    colDefs.forEach(col => {
      doc.text(col.header, x, tableTop + 5, { width: col.width, align: col.align });
      x += col.width;
    });

    doc.font('Helvetica').fontSize(8);
    let y = tableTop + headerHeight;
    rows.forEach(row => {
      // No background fill for rows to ensure maximum contrast
      // (text is black on white background)
      doc.fillColor('black');
      x = startX;
      colDefs.forEach(col => {
        const cellText = String(col.getter(row));
        doc.text(cellText, x, y + 4, { width: col.width, align: col.align });
        x += col.width;
      });
      y += rowHeight;
    });

    doc.strokeColor('black').rect(startX, tableTop, 500, headerHeight + rows.length * rowHeight).stroke();
    doc.end();
  }
});

// GET /api/v1/keys/:client_id - List all API keys for a specific client (admin only)
app.get('/api/v1/keys/:client_id', async (req, res) => {
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

// GET /api/v1/branding - List all client brandings (admin only)
app.get('/api/v1/branding', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query(`
    SELECT client_id, logo_url, primary_color, secondary_color, custom_domain, footer_text
    FROM client_branding
    ORDER BY client_id
  `);
  res.json({ branding: result.rows });
});

// Admin endpoint to create or update client branding
app.post('/api/v1/branding', doubleCsrfProtection, async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id, logo_url, primary_color, secondary_color, custom_domain, footer_text } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  // Validate colors (basic regex for hex)
  const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;
  if (primary_color && !hexColorRegex.test(primary_color)) {
    return res.status(400).json({ error: 'primary_color must be a valid hex color (#RRGGBB)' });
  }
  if (secondary_color && !hexColorRegex.test(secondary_color)) {
    return res.status(400).json({ error: 'secondary_color must be a valid hex color (#RRGGBB)' });
  }

  await pool.query(
    `INSERT INTO client_branding (client_id, logo_url, primary_color, secondary_color, custom_domain, footer_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id) DO UPDATE SET
       logo_url = EXCLUDED.logo_url,
       primary_color = EXCLUDED.primary_color,
       secondary_color = EXCLUDED.secondary_color,
       custom_domain = EXCLUDED.custom_domain,
       footer_text = EXCLUDED.footer_text`,
    [client_id, logo_url || null, primary_color || '#0f0', secondary_color || '#222', custom_domain || null, footer_text || null]
  );
  const adminUser = getAdminUser(req);
  await logAdminAction(adminUser, 'UPDATE_BRANDING', client_id, { client_id, logo_url, primary_color, secondary_color, custom_domain });
  res.json({ success: true, client_id });
});

// DELETE /api/v1/branding/:client_id - Remove branding for a client (admin only)
app.delete('/api/v1/branding/:client_id', doubleCsrfProtection, async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id } = req.params;
  await pool.query('DELETE FROM client_branding WHERE client_id = $1', [client_id]);
  const adminUser = getAdminUser(req);
  await logAdminAction(adminUser, 'DELETE_BRANDING', client_id, {});
  res.json({ success: true, client_id });
});

// Admin endpoint to get branding for a single client (for editing)
app.get('/api/v1/branding/admin/:client_id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id } = req.params;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const result = await pool.query(
    `SELECT logo_url, primary_color, secondary_color, custom_domain, footer_text
     FROM client_branding
     WHERE client_id = $1`,
    [client_id]
  );
  if (result.rows.length === 0) {
    return res.json({ client_id, logo_url: null, primary_color: '#0f0', secondary_color: '#222', custom_domain: null, footer_text: null });
  }
  res.json({
    client_id,
    logo_url: result.rows[0].logo_url,
    primary_color: result.rows[0].primary_color,
    secondary_color: result.rows[0].secondary_color,
    custom_domain: result.rows[0].custom_domain,
    footer_text: result.rows[0].footer_text
  });
});

// Logout endpoint
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Logout failed');
    }

    res.clearCookie('agegate.sid', { path: '/' });
    res.redirect('/login');
  });
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

// Public landing page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Age Gate as a Service – EU Blueprint age verification</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #111; color: #0f0; margin: 0; padding: 0; line-height: 1.5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .hero { text-align: center; padding: 60px 20px; }
        .hero h1 { font-size: 3rem; margin-bottom: 20px; }
        .hero p { font-size: 1.2rem; color: #aaa; max-width: 700px; margin: 0 auto; }
        .btn { display: inline-block; background: #0f0; color: #111; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-top: 20px; }
        .features { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; margin: 60px 0; }
        .feature-card { background: #222; padding: 20px; border-radius: 12px; width: 280px; text-align: center; }
        .feature-card h3 { margin-top: 0; }
        .footer { text-align: center; padding: 40px; border-top: 1px solid #333; margin-top: 60px; color: #666; }
        a { color: #0f0; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="hero">
          <h1>⚡ Age Gate as a Service</h1>
          <p>EU Blueprint compliant age verification with double anonymity. Protect your content while respecting user privacy.</p>
          <a href="/pricing" class="btn">Get started →</a>
        </div>
        <div class="features">
          <div class="feature-card"><h3>🔒 Double anonymity</h3><p>IPs are hashed with daily rotating salt – never stored.</p></div>
          <div class="feature-card"><h3>📊 Real‑time analytics</h3><p>Client dashboard with charts and usage stats.</p></div>
          <div class="feature-card"><h3>🔔 Webhook support</h3><p>Async notifications on every verification.</p></div>
          <div class="feature-card"><h3>📄 AGCOM export</h3><p>One‑click compliance report (CSV/PDF).</p></div>
          <div class="feature-card"><h3>🚀 High scalability</h3><p>Built on K3s, Redis, TimescaleDB – ready for production.</p></div>
          <div class="feature-card"><h3>🛡️ EU Blueprint ready</h3><p>Follows ageverification.dev guidelines.</p></div>
        </div>
        <div class="footer">
          <p>© 2026 Age Gate as a Service | <a href="/pricing">Pricing</a> | <a href="/api-docs">API Docs</a> | <a href="/login">Admin login</a></p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Pricing page
app.get('/pricing', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Pricing – Age Gate as a Service</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #111; color: #0f0; margin: 0; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 40px; }
        .pricing-grid { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; }
        .plan { background: #222; border-radius: 16px; padding: 30px; width: 280px; text-align: center; }
        .plan h2 { margin-top: 0; }
        .price { font-size: 2rem; font-weight: bold; margin: 20px 0; }
        .features-list { list-style: none; padding: 0; text-align: left; margin: 20px 0; }
        .features-list li { margin: 10px 0; }
        .btn { display: inline-block; background: #0f0; color: #111; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold; }
        .footer { text-align: center; margin-top: 60px; color: #666; }
        a { color: #0f0; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Simple, transparent pricing</h1>
        <div class="pricing-grid">
          <div class="plan"><h2>Free</h2><div class="price">€0 / month</div><ul class="features-list"><li>✅ 100 req/min</li><li>✅ 1,000 verifications/day</li><li>✅ Self‑service dashboard</li><li>❌ Webhooks</li><li>❌ AGCOM export</li></ul><a href="/register" class="btn">Get started</a></div>
          <div class="plan"><h2>Pro</h2><div class="price">€49 / month</div><ul class="features-list"><li>✅ 1,000 req/min</li><li>✅ 10,000 verifications/day</li><li>✅ Self‑service dashboard</li><li>✅ Webhooks</li><li>✅ AGCOM export</li><li>✅ Priority support</li></ul><a href="/register" class="btn">Choose plan</a></div>
          <div class="plan"><h2>Enterprise</h2><div class="price">Custom</div><ul class="features-list"><li>✅ Unlimited requests</li><li>✅ Custom rate limits</li><li>✅ White‑label branding</li><li>✅ SLA & dedicated support</li><li>✅ On‑premise deployment</li></ul><a href="/register" class="btn">Contact us</a></div>
        </div>
        <div class="footer">
          <p><a href="/">← Back to home</a> | <a href="/api-docs">API Docs</a> | <a href="/login">Admin login</a></p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// GET /api/v1/plans - List available plans (public)
app.get('/api/v1/plans', async (req, res) => {
  const plans = await pool.query('SELECT id, name, price_cents, interval, features FROM plans WHERE stripe_price_id IS NOT NULL OR name = $1', ['Free']);
  res.json(plans.rows);
});

// GET /api/v1/client/subscription - Get current subscription details for the client
app.get('/api/v1/client/subscription', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });
  const keyCheck = await pool.query('SELECT client_id FROM api_keys WHERE api_key = $1', [apiKey]);
  if (keyCheck.rows.length === 0) return res.status(401).json({ error: 'Invalid API key' });
  const clientId = keyCheck.rows[0].client_id;
  const subRes = await pool.query(`
    SELECT s.status, s.current_period_end, p.name as plan_name, p.rate_limit, p.daily_limit
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.client_id = $1 AND s.status = 'active'
    ORDER BY s.created_at DESC LIMIT 1
  `, [clientId]);
  if (subRes.rows.length === 0) {
    // Fallback to free plan
    const freePlan = await pool.query('SELECT name, rate_limit, daily_limit FROM plans WHERE name = $1', ['Free']);
    return res.json({
      plan_name: freePlan.rows[0].name,
      rate_limit: freePlan.rows[0].rate_limit,
      daily_limit: freePlan.rows[0].daily_limit,
      status: 'free',
    });
  }
  // Generate Stripe customer portal URL
  const stripeCustomer = await pool.query('SELECT stripe_customer_id FROM api_keys WHERE client_id = $1', [clientId]);
  let portalUrl = null;
  if (stripe && stripeCustomer.rows[0]?.stripe_customer_id) {
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomer.rows[0].stripe_customer_id,
        return_url: `${PUBLIC_URL}/api/v1/client/dashboard`,
      });
      portalUrl = session.url;
    } catch (err) {
      logger.error({ err }, 'Failed to create Stripe portal session');
    }
  }
  res.json({
    plan_name: subRes.rows[0].plan_name,
    rate_limit: subRes.rows[0].rate_limit,
    daily_limit: subRes.rows[0].daily_limit,
    status: subRes.rows[0].status,
    current_period_end: subRes.rows[0].current_period_end,
    portal_url: portalUrl,
  });
});

// Stripe Checkout session (client authenticated via API key)
app.post('/api/v1/stripe/create-checkout-session', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  const keyCheck = await pool.query(
    `SELECT client_id FROM api_keys WHERE api_key = $1 AND is_active = true`,
    [apiKey]
  );
  if (keyCheck.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  const clientId = keyCheck.rows[0].client_id;
  const { priceId, successUrl, cancelUrl } = req.body;
  if (!priceId || !successUrl || !cancelUrl) {
    return res.status(400).json({ error: 'priceId, successUrl and cancelUrl are required' });
  }
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  try {
    // Get or create Stripe customer for this client
    let customerId = null;
    const custRes = await pool.query('SELECT stripe_customer_id FROM api_keys WHERE api_key = $1', [apiKey]);
    if (custRes.rows[0]?.stripe_customer_id) {
      customerId = custRes.rows[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        metadata: { client_id: clientId },
      });
      customerId = customer.id;
      await pool.query('UPDATE api_keys SET stripe_customer_id = $1 WHERE api_key = $2', [customerId, apiKey]);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { client_id: clientId, api_key: apiKey },
    });
    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    logger.error({ err }, 'Stripe checkout error');
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook endpoint (public, verifies signature)
app.post('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe not configured');
  }
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const clientId = session.metadata.client_id;
      const apiKey = session.metadata.api_key;
      const subscriptionId = session.subscription;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0].price.id;
      const planRes = await pool.query('SELECT id, rate_limit, daily_limit FROM plans WHERE stripe_price_id = $1', [priceId]);
      if (planRes.rows.length === 0) {
        logger.error({ priceId }, 'No plan found for price');
        break;
      }
      const plan = planRes.rows[0];
      await pool.query(
        `UPDATE api_keys SET rate_limit = $1, daily_limit = $2 WHERE api_key = $3`,
        [plan.rate_limit, plan.daily_limit, apiKey]
      );
      await pool.query(
        `INSERT INTO subscriptions (client_id, stripe_subscription_id, plan_id, status, current_period_end)
         VALUES ($1, $2, $3, $4, to_timestamp($5))`,
        [clientId, subscriptionId, plan.id, subscription.status, subscription.current_period_end]
      );
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const subscriptionId = subscription.id;
      const status = subscription.status;
      const currentPeriodEnd = subscription.current_period_end;
      const subRes = await pool.query('SELECT plan_id, client_id FROM subscriptions WHERE stripe_subscription_id = $1', [subscriptionId]);
      if (subRes.rows.length === 0) break;
      const { plan_id, client_id } = subRes.rows[0];
      const planRes = await pool.query('SELECT rate_limit, daily_limit FROM plans WHERE id = $1', [plan_id]);
      const plan = planRes.rows[0];
      await pool.query(
        `UPDATE api_keys SET rate_limit = $1, daily_limit = $2 WHERE client_id = $3`,
        [plan.rate_limit, plan.daily_limit, client_id]
      );
      await pool.query(
        `UPDATE subscriptions SET status = $1, current_period_end = to_timestamp($2), updated_at = NOW()
         WHERE stripe_subscription_id = $3`,
        [status, currentPeriodEnd, subscriptionId]
      );
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const subscriptionId = subscription.id;
      const freePlan = await pool.query('SELECT rate_limit, daily_limit FROM plans WHERE name = $1', ['Free']);
      if (freePlan.rows.length > 0) {
        const subRes = await pool.query('SELECT client_id FROM subscriptions WHERE stripe_subscription_id = $1', [subscriptionId]);
        if (subRes.rows.length > 0) {
          await pool.query(
            `UPDATE api_keys SET rate_limit = $1, daily_limit = $2 WHERE client_id = $3`,
            [freePlan.rows[0].rate_limit, freePlan.rows[0].daily_limit, subRes.rows[0].client_id]
          );
        }
      }
      await pool.query('UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2', ['canceled', subscriptionId]);
      break;
    }
  }
  res.json({ received: true });
});

// ==================== SERVER START + GRACEFUL SHUTDOWN ====================
let server;

async function startServer() {
  try {
    await loadSessionSecrets();

    if (process.env.NODE_ENV !== 'test' && !sessionSecretRotationTimer) {
      sessionSecretRotationTimer = setInterval(() => {
        rotateSessionSecret().catch(err => {
          logger.error({ err }, 'Scheduled session secret rotation failed');
        });
      }, 24 * 60 * 60 * 1000);
      sessionSecretRotationTimer.unref();
    }

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

if (require.main === module) {
  startServer();
}

let shuttingDown = false;

// Graceful shutdown
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  if (sessionSecretRotationTimer) {
    clearInterval(sessionSecretRotationTimer);
    sessionSecretRotationTimer = undefined;
  }

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

function getSessionSecretsSnapshot() {
  return [...sessionSecrets];
}

module.exports = {
  app, getServer: () => server, pool,
  loadSessionSecrets, rotateSessionSecret, getSessionSecretsSnapshot
};
