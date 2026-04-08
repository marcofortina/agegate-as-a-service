# Integration Example: Age Verification in Your Website

This document provides a practical example of how to integrate Age Gate as a Service into a website or backend application.

## Scenario

A website (e.g., `casino-italia.it`) needs to verify that a user is over 18 before allowing access to a restricted page.

## Step 1: Obtain an API Key

Contact the Age Gate administrator to obtain an API key for your domain. The key will look like:

```
agk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p
```

## Step 2: Frontend Integration (JavaScript)

Add the Age Gate SDK to your HTML page (the SDK is served from the Age Gate service):

```html
<script src="https://agegate.yourdomain.com/sdk/agegate-sdk.js"></script>
```

Then, call the verification function before showing restricted content:

```javascript
ageGate.verify({
  apiKey: 'agk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p',
  threshold: 18,
  onSuccess: function(result) {
    // User is verified, show restricted content
    console.log('Verified:', result);
    document.getElementById('restricted-content').style.display = 'block';
  },
  onError: function(error) {
    // Verification failed (underage, missing API key, etc.)
    alert('Age verification failed: ' + error.message);
  }
});
```

The SDK automatically collects the user's IP address (anonymized by the server) and sends the request to the Age Gate backend.

## Step 3: Backend Integration (Node.js Example)

If you prefer to verify on the server side, send a `POST` request to the `/verify` endpoint.

```javascript
const axios = require('axios');

async function verifyAge(userIp, threshold = 18) {
  try {
    const response = await axios.post('https://agegate.yourdomain.com/verify', {
      client_id: 'casino-italia.it',
      threshold: threshold,
      // Note: client_ip is not sent; the server reads it from the request
    }, {
      headers: {
        'x-api-key': 'agk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p',
        'Content-Type': 'application/json'
      }
    });
    return response.data.verified; // true or false
  } catch (error) {
    console.error('Verification error:', error.response?.data || error.message);
    return false;
  }
}
```

## Step 4: Backend Integration (PHP Example)

```php
$apiKey = 'agk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p';
$clientId = 'casino-italia.it';
$threshold = 18;

$ch = curl_init('https://agegate.yourdomain.com/verify');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'x-api-key: ' . $apiKey,
    'Content-Type: application/json'
]);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
    'client_id' => $clientId,
    'threshold' => $threshold
]));

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($httpCode === 200) {
    $data = json_decode($response, true);
    $isVerified = $data['verified'];
    // Proceed or block accordingly
} else {
    // Handle error (e.g., rate limit, invalid key)
}
```

## Step 5: Testing with cURL

```bash
curl -X POST https://agegate.yourdomain.com/verify \
  -H "x-api-key: agk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p" \
  -H "Content-Type: application/json" \
  -d '{"client_id": "casino-italia.it", "threshold": 18}'
```

Successful response:
```json
{
  "status": "success",
  "message": "Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)",
  "verified": true,
  "ageOverThreshold": true,
  "issuerTrusted": true,
  "threshold": 18,
  "timestamp": "2026-04-08T12:00:00.000Z",
  "proofType": "mock"
}
```

## Rate Limiting

Each API key is limited to **100 requests per minute** (per client IP). If you exceed this, you will receive a `429` status code.

## Important Notes

- **Double anonymity**: The Age Gate service never logs the client's real IP address; only an irreversible hash is stored.
- **No personal data**: The verification only returns a boolean result; no age or other personal data is disclosed.
- **EU Blueprint compliant**: The service follows the ageverification.dev specification.

## Troubleshooting Common Errors

| HTTP Status | Meaning |
|-------------|---------|
| 401 | Missing or invalid API key, or key expired |
| 429 | Rate limit exceeded (100 requests per minute) |
| 400 | Invalid request body (e.g., missing `client_id` or threshold out of range) |
| 500 | Internal server error (contact administrator) |

## Next Steps

- Review the [API documentation](./api.md) for more endpoints.
- For high‑volume sites, request a dedicated rate limit increase.
- To rotate your API key, contact the administrator or use the admin dashboard.
