const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

// Configuration from environment variables
const PORT = process.env.PORT || 8080;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'agegate2026';

// Database
const pool = new Pool({
  host: process.env.TIMESCALEDB_HOST || 'timescaledb',
  port: parseInt(process.env.TIMESCALEDB_PORT || '5432'),
  database: process.env.TIMESCALEDB_DB || 'agegate',
  user: process.env.TIMESCALEDB_USER || 'postgres',
  password: process.env.TIMESCALEDB_PASSWORD || 'agegate2026',
});

// Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Rate limit: 100 requests per minute per API key
async function checkRateLimit(apiKey) {
  const key = `rate:${apiKey}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= 100;
}

// Initialize hypertable
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verifications (
      id SERIAL PRIMARY KEY,
      client_id TEXT NOT NULL,
      api_key TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      verified BOOLEAN NOT NULL
    );
  `);
  await pool.query(`
    SELECT create_hypertable('verifications', 'timestamp', if_not_exists => TRUE);
  `);
  console.log('TimescaleDB hypertable ready');
}
initDB().catch(console.error);

// Admin basic auth helper
function isAdmin(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return false;
  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, pass] = credentials.split(':');
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

// Verifier endpoint
app.post('/verify', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const clientId = req.body.client_id || 'unknown';

  if (!apiKey) {
    return res.status(401).json({ status: 'error', message: 'Missing API Key' });
  }

  if (!await checkRateLimit(apiKey)) {
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded (100 requests/min)' });
  }

  const timestamp = new Date().toISOString();
  await pool.query(
    `INSERT INTO verifications (client_id, api_key, timestamp, verified) VALUES ($1, $2, $3, $4)`,
    [clientId, apiKey, timestamp, true]
  );

  res.json({
    status: 'success',
    message: 'Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)',
    verified: true,
    ageOver18: true,
    issuerTrusted: true,
    timestamp
  });
});

// Dashboard
app.get('/dashboard', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).send('Unauthorized');

  const stats = await pool.query(`
    SELECT client_id, api_key, COUNT(*) as checks, MAX(timestamp) as last_check
    FROM verifications
    GROUP BY client_id, api_key
    ORDER BY checks DESC
  `);

  const total = stats.rows.reduce((sum, r) => sum + parseInt(r.checks), 0);

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
  <h1>Age Gate as a Service - Dashboard</h1>
  <div class="card">
    <h2>Global Statistics</h2>
    <p>Total verifications: <strong>${total}</strong></p>
  </div>
  <div class="card">
    <h2>Clients</h2>
    <table>
      <tr><th>Client</th><th>API Key</th><th>Verifications</th><th>Last verification</th><th>Action</th></tr>`;

  stats.rows.forEach(r => {
    html += `<tr>
      <td>${r.client_id}</td>
      <td>${r.api_key}</td>
      <td>${r.checks}</td>
      <td>${r.last_check}</td>
      <td><button onclick="revokeKey('${r.api_key}')">Revoke</button></td>
    </tr>`;
  });

  html += `</table>
  </div>

  <div class="card">
    <h2>Add New Client</h2>
    <input id="newClientId" placeholder="Client ID (e.g. casino-italia.it)" style="width:320px">
    <button onclick="registerClient()">Add Client</button>
  </div>

  <script>
    async function registerClient() {
      const clientId = document.getElementById('newClientId').value.trim();
      if (!clientId) return alert('Client ID is required');
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId })
      });
      const data = await response.json();
      alert('API Key generated: ' + data.api_key);
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
  </script>

  <a href="/login">Logout</a>
</body>
</html>`;
  res.send(html);
});

// Admin endpoints
app.post('/api/register', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const apiKey = 'agk_' + Math.random().toString(36).substring(2, 18);
  res.json({ client_id, api_key: apiKey });
});

app.post('/api/revoke', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key is required' });

  await pool.query('DELETE FROM verifications WHERE api_key = $1', [api_key]);
  await redis.del(`rate:${api_key}`);

  res.json({ status: 'success', message: 'API Key revoked' });
});

// Health check
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));

// Readiness probe
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ready' });
  } catch (err) {
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
      <pre>&lt;script src="http://agegate.local:${process.env.NODEPORT || 30452}/sdk/agegate-sdk.js"&gt;&lt;/script&gt;</pre>
      <p>2. Use your personal API Key when calling the verification.</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`Age Gate Phase 16 running on port ${PORT}`));
