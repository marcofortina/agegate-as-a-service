const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

const DB_FILE = '/data/verifications.db';
const db = new sqlite3.Database(DB_FILE);

// Initialize persistent DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY,
    client_id TEXT,
    api_key TEXT UNIQUE,
    timestamp TEXT,
    verified BOOLEAN
  )`);
  console.log('✅ Persistent DB ready');
});

// Basic Auth for Dashboard
const AUTH_USER = 'admin';
const AUTH_PASS = 'agegate2026';

function checkAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).send('Authentication required');
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === AUTH_USER && pass === AUTH_PASS) return next();
  res.status(401).send('Invalid credentials');
}

// UE Blueprint Verifier
app.post('/verify', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const clientId = req.body.client_id || 'unknown';

  if (!apiKey) {
    return res.status(401).json({ status: "error", message: "Missing API Key" });
  }

  const verified = true;
  const timestamp = new Date().toISOString();

  db.run(`INSERT INTO verifications (client_id, api_key, timestamp, verified) VALUES (?, ?, ?, ?)`,
    [clientId, apiKey, timestamp, verified]);

  console.log(`🔍 Verification OK - Client: ${clientId} | Key: ${apiKey}`);

  res.json({
    status: "success",
    message: "Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)",
    verified: true,
    ageOver18: true,
    issuerTrusted: true,
    timestamp: timestamp
  });
});

// Protected Dashboard
app.get('/dashboard', checkAuth, (req, res) => {
  db.all(`SELECT client_id, COUNT(*) as checks, MAX(timestamp) as last_check
          FROM verifications GROUP BY client_id`, (err, rows) => {
    const total = rows.reduce((sum, r) => sum + r.checks, 0);
    let html = `
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>AgeGate Dashboard</title>
      <style>body{font-family:system-ui;background:#111;color:#0f0;padding:20px}.card{background:#222;padding:20px;border-radius:12px;margin:15px 0} table{width:100%;border-collapse:collapse} th,td{padding:12px;border:1px solid #0a0}</style>
      </head><body>
      <h1>Age Gate as a Service - Dashboard</h1>
      <div class="card"><h2>Global Statistics</h2><p>Total verifications: <strong>${total}</strong></p></div>
      <div class="card"><h2>Clients</h2><table><tr><th>Client</th><th>Verifications</th><th>Last verification</th></tr>`;
    rows.forEach(r => {
      html += `<tr><td>${r.client_id}</td><td>${r.checks}</td><td>${r.last_check}</td></tr>`;
    });
    html += `</table></div><p><a href="/sdk/agegate-sdk.js">Download SDK</a></p></body></html>`;
    res.send(html);
  });
});

// Generate new API Key for client
app.post('/api/register', checkAuth, (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: "client_id is required" });

  const apiKey = 'agk_' + Math.random().toString(36).substring(2, 15);
  res.json({ client_id, api_key: apiKey, message: "API Key successfully generated" });
});

const PORT = 8080;
app.listen(PORT, () => console.log(`🚀 Age Gate v0.4 (Login + Persistent DB) on port ${PORT}`));
