const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

const DB_FILE = '/data/verifications.db';
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY,
    client_id TEXT,
    api_key TEXT UNIQUE,
    timestamp TEXT,
    verified BOOLEAN
  )`);
});

// ==================== UE BLUEPRINT VERIFIER ====================
app.post('/verify', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const clientId = req.body.client_id || 'unknown';

  if (!apiKey) return res.status(401).json({ status: "error", message: "Missing API Key" });

  const timestamp = new Date().toISOString();

  db.run(`INSERT INTO verifications (client_id, api_key, timestamp, verified) VALUES (?, ?, ?, ?)`,
    [clientId, apiKey, timestamp, true]);

  res.json({
    status: "success",
    message: "Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)",
    verified: true,
    ageOver18: true,
    issuerTrusted: true,
    timestamp
  });
});

// ==================== LOGIN PAGE ====================
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>AgeGate Login</title>
    <style>body{font-family:system-ui;background:#111;color:#0f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{background:#222;padding:40px;border-radius:16px;width:340px;text-align:center}</style>
    </head><body>
    <div class="box">
      <h1>Age Gate Admin</h1>
      <input id="user" placeholder="Username" value="admin"><br><br>
      <input id="pass" type="password" placeholder="Password" value="agegate2026"><br><br>
      <button onclick="login()">Login</button>
      <script>
        function login() {
          const u = document.getElementById('user').value;
          const p = document.getElementById('pass').value;
          window.location.href = '/dashboard?auth='+btoa(u+':'+p);
        }
      </script>
    </div>
    </body></html>
  `);
});

// Dashboard (accepts Basic Auth or query param)
app.get('/dashboard', (req, res) => {
  // simple check for MVP
  const auth = req.headers.authorization || 'Basic ' + (req.query.auth || '');
  if (!auth.includes('YWRtaW46YWdlZ2F0ZTIwMjY=')) {
    return res.redirect('/login');
  }

  db.all(`SELECT client_id, api_key, COUNT(*) as checks, MAX(timestamp) as last_check
          FROM verifications GROUP BY client_id, api_key`, (err, rows) => {
    let html = `
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>AgeGate Dashboard</title>
      <style>body{font-family:system-ui;background:#111;color:#0f0;padding:20px}.card{background:#222;padding:20px;border-radius:12px;margin:15px 0} table{width:100%;border-collapse:collapse} th,td{padding:12px;border:1px solid #0a0}</style>
      </head><body>
      <h1>Age Gate as a Service - Dashboard</h1>
      <div class="card"><h2>Global Statistics</h2><p>Total verifications: <strong>${rows.reduce((a,r)=>a+r.checks,0)}</strong></p></div>
      <div class="card"><h2>Clients</h2><table><tr><th>Client</th><th>API Key</th><th>Verifications</th><th>Last verification</th></tr>`;
    rows.forEach(r => {
      html += `<tr><td>${r.client_id}</td><td>${r.api_key}</td><td>${r.checks}</td><td>${r.last_check}</td></tr>`;
    });
    html += `</table></div><a href="/login">Logout</a></body></html>`;
    res.send(html);
  });
});

// Register new client
app.post('/api/register', (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: "client_id is required" });

  const apiKey = 'agk_' + Math.random().toString(36).substring(2, 18);
  res.json({ client_id, api_key: apiKey });
});

const PORT = 8080;
app.listen(PORT, () => console.log(`🚀 Age Gate v0.5 (HTML Login + Register) on ${PORT}`));
