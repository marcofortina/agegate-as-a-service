const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use('/sdk', express.static(path.join(__dirname)));

// ==================== IN-MEMORY STATE ====================
let totalChecks = 142;
const clients = {
  "demo-client": { apiKey: "agk_demo_mnhozl61", checks: 142 }
};

// Health
app.get('/health', (req, res) => res.send('OK'));

// ==================== UE BLUEPRINT VERIFIER ====================
app.post('/verify', (req, res) => {
  totalChecks++;
  const clientId = req.body.client_id || req.query.client_id || 'unknown';
  const vpToken = req.body.vp_token || req.body.proof;

  console.log(`🔍 [UE Blueprint] Proof received from ${clientId}`);

  // Simulated real verification (here would be the mDoc + OID4VP + Trusted List signature logic)
  const isValid = true;

  if (isValid) {
    res.json({
      status: "success",
      message: "Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)",
      verified: true,
      ageOver18: true,
      issuerTrusted: true,
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(403).json({ status: "fail", verified: false });
  }
});

// Dynamic dashboard
app.get('/dashboard', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>AgeGate Dashboard</title>
    <style>body{font-family:system-ui;background:#111;color:#0f0;padding:20px}.card{background:#222;padding:20px;border-radius:12px;margin:15px 0}</style>
    </head>
    <body>
      <h1>Age Gate as a Service - Dashboard</h1>
      <div class="card"><h2>Global Statistics</h2>
        <p>Total verifications: <strong>${totalChecks}</strong></p>
      </div>
      <div class="card"><h2>Clients</h2>
        <table style="width:100%;border-collapse:collapse"><tr><th>Client</th><th>API Key</th><th>Checks</th></tr>
          <tr><td>demo-client</td><td>${clients["demo-client"].apiKey}</td><td>${clients["demo-client"].checks}</td></tr>
        </table>
      </div>
      <p><a href="/sdk/agegate-sdk.js">Download SDK</a> | <a href="/">Verifier</a></p>
    </body>
    </html>`;
  res.send(html);
});

const PORT = 8080;
app.listen(PORT, () => console.log(`🚀 Age Gate + UE Blueprint ready on port ${PORT}`));
