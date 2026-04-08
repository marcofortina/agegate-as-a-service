# API Key Management

## Security improvements

- **Cryptographically secure generation** – `crypto.randomBytes(24)` instead of `Math.random()`
- **Expiration** – Keys expire after 1 year (configurable in code)
- **Soft revocation** – Keys are marked `is_active = false` instead of being deleted
- **Rotation endpoint** – `/api/rotate` generates a new key and revokes the old one
- **Audit trail** – `created_by` and `last_used_at` columns track usage

## Database schema

```sql
CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_by TEXT
);
```

## Endpoints (admin only)

### Register a new client
```bash
curl -X POST http://agegate.local/api/register \
  -u admin:yourpassword \
  -H "Content-Type: application/json" \
  -d '{"client_id": "example.com"}'
```
Response: `{ "client_id": "example.com", "api_key": "agk_...", "expires_at": "2027-..." }`

### Revoke an API key
```bash
curl -X POST http://agegate.local/api/revoke \
  -u admin:yourpassword \
  -H "Content-Type: application/json" \
  -d '{"api_key": "agk_..."}'
```

### Rotate an API key
```bash
curl -X POST http://agegate.local/api/rotate \
  -u admin:yourpassword \
  -H "Content-Type: application/json" \
  -d '{"api_key": "agk_..."}'
```
Response: `{ "client_id": "...", "api_key": "agk_new...", "expires_at": "..." }`

## Validation during verification

Every `/verify` request:
1. Checks that the API key exists in `api_keys`
2. Verifies `is_active = true`
3. Verifies `expires_at` is not in the past
4. Updates `last_used_at` asynchronously

If validation fails, the endpoint returns `401 Invalid API key` or `401 API key expired`.

## Migration from old keys

The first time the application starts after this update, it will **not** automatically migrate existing keys from the `verifications` table.
To keep compatibility, you can manually insert old keys into `api_keys` (e.g., via a one-time script).
However, new keys generated after this update will be stored in the `api_keys` table.

## Admin dashboard

The dashboard at `/dashboard` now shows:
- All API keys with status (active/revoked)
- Creation and expiration dates
- Last used timestamp
- Buttons to **Revoke** or **Rotate** each key

## Rate limiting

Rate limiting continues to use the same Redis keys (`rate:${apiKey}:${anonymizedIP}`). Revoking a key also clears its rate limit counters from Redis.
