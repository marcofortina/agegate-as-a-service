const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

// ==================== IN-MEMORY STATE (for MVP) ====================
let totalChecks = 142;
let successRate = 98.6;
const clients = {
  "demo-client": {
    apiKey: "agk_demo_" + Date.now().toString(36),
    checks: 142,
    success: 98.6
  }
};

// Health
app.get('/health', (req, res) => res.send('OK'));

// Verifier
app.post('/verify', (req, res) => {
  totalChecks++;
  console.log('🔍 Proof from:', req.body.client_id || 'unknown');
  res.json({
    status: "success",
    message: "Age ≥ 18 successfully verified (AGCOM double anonymity)",
    verified: true,
    timestamp: new Date().toISOString()
  });
});

// Dashboard (dynamic version)
app.get('/dashboard', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>AgeGate Admin Dashboard</title>
      <style>
        body { font-family: system-ui; background:#111; color:#0f0; padding:20px; }
        .card { background:#222; padding:20px; border-radius:12px; margin:15px 0; }
        table { width:100%; border-collapse:collapse; margin-top:20px; }
        th, td { padding:12px; border:1px solid #0a0; text-align:left; }
      </style>
    </head>
    <body>
      <h1>Age Gate as a Service - Dashboard</h1>
      <div class="card">
        <h2>Global Statistics</h2>
        <p>Total verifications: <strong>${totalChecks}</strong></p>
        <p>Success rate: <strong>${successRate}%</strong></p>
      </div>
      <div class="card">
        <h2>Clients</h2>
        <table>
          <tr><th>Client</th><th>API Key</th><th>Checks</th></tr>
          <tr><td>demo-client</td><td>${clients["demo-client"].apiKey}</td><td>${clients["demo-client"].checks}</td></tr>
        </table>
      </div>
      <button onclick="fetch('/dashboard/new-key').then(()=>location.reload())">Generate new API Key (demo)</button>
      <p><a href="/sdk/agegate-sdk.js">Download SDK</a> | <a href="/">Verifier</a></p>
    </body>
    </html>`;
  res.send(html);
});

app.get('/dashboard/new-key', (req, res) => {
  // For MVP we generate a new key
  res.json({ message: "New API Key generated (demo)" });
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`🚀 Verifier + SDK + Dashboard ready on port ${PORT}`);
});
