# Configurable Rate Limiting per API Key

Age Gate as a Service supports per‑key rate limiting. Each API key has a configurable limit of requests per minute (default 100).

## How it works

- The rate limit is enforced per `(api_key, anonymized_ip)` pair.
- The limit is stored in the `api_keys` table (`rate_limit` column).
- Admin can change the limit via a dedicated endpoint.

## Admin Endpoint

### `PATCH /api/keys/:api_key/rate-limit`

Update the rate limit for a specific API key.

**Authentication:** Admin (Basic Auth)

**Request body:**
```json
{
  "rate_limit": 200
}
```

**Response:**
```json
{
  "success": true,
  "client_id": "example.com",
  "rate_limit": 200
}
```

**Constraints:** `rate_limit` must be an integer between 1 and 10000.

## Dashboard

The admin dashboard displays the current rate limit for each API key in the table.

## Defaults

New API keys are created with a default rate limit of 100 requests per minute.

## Performance Note

Reading the rate limit from the database on every request adds a small overhead. For high‑traffic keys, consider caching the value in Redis (future improvement).
