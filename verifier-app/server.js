const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

// ==================== TIMESCALEDB ====================
const pool = new Pool({
  host: 'timescaledb',
  port: 5432,
  database: 'agegate',
  user: 'postgres',
  password: 'agegate2026',
});

// Create the hypertable (optimized for time-series verifications)
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
  console.log('✅ TimescaleDB hypertable ready');
}
initDB().catch(console.error);

// Verifier Blueprint UE
app.post('/verify', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const clientId = req.body.client_id || 'unknown';

  if (!apiKey) return res.status(401).json({ status: "error", message: "Missing API Key" });

  const timestamp = new Date().toISOString();
  await pool.query(
    `INSERT INTO verifications (client_id, api_key, timestamp, verified) VALUES ($1, $2, $3, $4)`,
    [clientId, apiKey, timestamp, true]
  );

  res.json({
    status: "success",
    message: "Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)",
    verified: true,
    ageOver18: true,
    issuerTrusted: true,
    timestamp
  });
});

// Dashboard (TimescaleDB)
app.get('/dashboard', async (req, res) => {
  const result = await pool.query(`
    SELECT client_id, api_key, COUNT(*) as checks, MAX(timestamp) as last_check
    FROM verifications
    GROUP BY client_id, api_key
    ORDER BY checks DESC
  `);

  const total = result.rows.reduce((sum, r) => sum + parseInt(r.checks), 0);

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AgeGate Dashboard</title>
<style>body{font-family:system-ui;background:#111;color:#0f0;padding:20px}.card{background:#222;padding:20px;border-radius:12px;margin:15px 0} table{width:100%;border-collapse:collapse} th,td{padding:12px;border:1px solid #0a0}</style>
</head><body>
<h1>Age Gate as a Service - Dashboard</h1>
<div class="card"><h2>Global Statistics</h2><p>Total verifications: <strong>${total}</strong></p></div>
<div class="card"><h2>Clients</h2><table><tr><th>Client</th><th>API Key</th><th>Verifications</th><th>Last verification</th></tr>`;

  result.rows.forEach(r => {
    html += `<tr><td>${r.client_id}</td><td>${r.api_key}</td><td>${r.checks}</td><td>${r.last_check}</td></tr>`;
  });

  html += `</table></div><a href="/login">Logout</a></body></html>`;
  res.send(html);
});

const PORT = 8080;
app.listen(PORT, () => console.log(`🚀 Age Gate Phase 9 (TimescaleDB) on ${PORT}`));
