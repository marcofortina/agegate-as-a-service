# API Reference

All API endpoints are accessible under the `/api/v1` prefix. The base URL is `https://agegate.example.com/api/v1`.

## Age Verification

### `POST /api/v1/verify`

Header: `x-api-key`
Body:
```json
{
  "client_id": "example.com",
  "threshold": 18
}
```

Response (success – age ≥ threshold):
 ```json
 {
   "status": "success",
  "message": "Age ≥ 18 successfully verified (AGCOM double anonymity - UE Blueprint)",
  "verified": true,
  "ageOverThreshold": true,
  "issuerTrusted": true,
  "threshold": 18,
  "timestamp": "2026-04-11T12:00:00.000Z",
  "proofType": "mock"
}
```

Response (failure – underage or invalid key):
```json
{
  "status": "error",
  "message": "Age verification failed - user is under 18"
}
```

### Rate Limit Headers

Every response from `/api/v1/verify` includes the following HTTP headers:
- `X-RateLimit-Limit` – maximum requests per minute for this API key
- `X-RateLimit-Remaining` – remaining requests in the current minute window
- `X-RateLimit-Reset` – timestamp (Unix seconds) when the limit resets
- If a daily limit is configured, additional headers `X-DailyLimit-Limit`, `X-DailyLimit-Remaining`, and `X-DailyLimit-Reset` are also returned.

## Client Statistics

### `GET /api/v1/stats`

Header: `x-api-key`

Response:
```json
{
  "client_id": "example.com",
  "total_verifications": 1240,
  "successful_verifications": 1178,
  "success_rate": 95.0,
  "last_verification": "2026-04-11T12:00:00.000Z",
  "daily_breakdown": [...]
}
```

## Client Self‑Service

- `GET /api/v1/client/dashboard` – HTML dashboard for clients (requires `x-api-key`)
- `GET /api/v1/client/description` – Retrieve description of the API key
- `PATCH /api/v1/client/description` – Update description
- `POST /api/v1/client/rotate` – Rotate the API key (generates new key, revokes old)

## Admin Endpoints (require admin session)

See [API Key Management](./api-keys.md) for `POST /register`, `POST /revoke`, `POST /rotate`.

Additional admin endpoints:
- `GET /api/v1/webhooks` – List all webhooks
- `POST /api/v1/webhook` – Set webhook for a client
- `DELETE /api/v1/webhook/:client_id` – Remove webhook
- `GET /api/v1/export/compliance` – Export AGCOM report (CSV/PDF)
- `GET /api/v1/keys/:client_id` – List all API keys for a client
- `PATCH /api/v1/keys/:api_key/rate-limit` – Update rate limit per minute
- `PATCH /api/v1/keys/:api_key/daily-limit` – Update daily quota
- `PATCH /api/v1/keys/:api_key/description` – Update description of an API key

The IP allowlist, if set, restricts verification requests to only those IP addresses or CIDR ranges. Requests from other IPs receive a `403 Forbidden`.

## Other Public Endpoints

- `GET /health` – Health check
- `GET /ready` – Readiness probe
- `GET /onboarding` – Public onboarding page
