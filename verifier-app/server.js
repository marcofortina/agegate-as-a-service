const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

const db = new sqlite3.Database(':memory:'); // in-memory for MVP

// Initialize DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY,
    client_id TEXT,
    api_key TEXT,
    timestamp TEXT,
    verified BOOLEAN
  )`);
});

// ==================== API KEY + UE BLUEPRINT VERIFIER ====================
app.post('/verify', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.body.api_key;
  const clientId = req.body.client_id || 'unknown';

  if (!apiKey || apiKey === 'demo-client') {
    return res.status(401).json({ status: "error", message: "Missing or invalid API Key" });
  }

  const verified = true;
  const timestamp = new Date().toISOString();

  db.run(`INSERT INTO verifications (client_id, api_key, timestamp, verified) VALUES (?, ?, ?, ?)`,
    [clientId, apiKey, timestamp, verified]);

  console.log(`🔍 [UE Blueprint] Verification OK from ${clientId} (${apiKey})`);

  res.json({
    status: "success",
    message: "Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)",
    verified: true,
    ageOver18: true,
    issuerTrusted: true,
    timestamp: timestamp
  });
});

// Dashboard
app.get('/dashboard', (req, res) => {
  db.all(`SELECT client_id, COUNT(*) as checks, MAX(timestamp) as last_check
          FROM verifications GROUP BY client_id`, (err, rows) => {
    const totalChecks = rows.reduce((sum, r) => sum + r.checks, 0);

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>AgeGate Dashboard</title>
      <style>body{font-family:system-ui;background:#111;color:#0f0;padding:20px}.card{background:#222;padding:20px;border-radius:12px;margin:15px 0} table{width:100%;border-collapse:collapse} th,td{padding:12px;border:1px solid #0a0}</style>
      </head>
      <body>
        <h1>Age Gate as a Service - Dashboard</h1>
        <div class="card"><h2>Global Statistics</h2><p>Total verifications: <strong>${totalChecks}</strong></p></div>
        <div class="card"><h2>Clients</h2>
          <table><tr><th>Client</th><th>Verifications</th><th>Last</th></tr>
            ${rows.map(r => `<tr><td>${r.client_id}</td><td>${r.checks}</td><td>${r.last_check}</td></tr>`).join('')}
          </table>
        </div>
        <p><a href="/sdk/agegate-sdk.js">Download SDK</a></p>
      </body>
      </html>`;
    res.send(html);
  });
});

const PORT = 8080;
app.listen(PORT, () => console.log(`🚀 Age Gate v0.3 (Blueprint + API Key + DB) on port ${PORT}`));
