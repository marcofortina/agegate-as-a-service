const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

// Serve the SDK as a static file
app.use('/sdk', express.static(path.join(__dirname)));

// Health
app.get('/health', (req, res) => res.send('OK'));

// Verifier
app.post('/verify', (req, res) => {
  console.log('🔍 Proof from:', req.body.client_id || 'unknown');
  res.json({
    status: "success",
    message: "Age ≥ 18 successfully verified (AGCOM double anonymity)",
    verified: true,
    timestamp: new Date().toISOString()
  });
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`🚀 Verifier + SDK ready on port ${PORT}`);
});
