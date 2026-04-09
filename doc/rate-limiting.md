# Configurable Rate Limiting per API Key

Age Gate as a Service supports per‑key rate limiting. Each API key has a configurable limit of requests per minute (default 100).

## How it works

- The rate limit is enforced per `(api_key, anonymized_ip)` pair.
- The limit is stored in the `api_keys` table (`rate_limit` column).
- Admin can change the limit via a dedicated endpoint or the admin dashboard.

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

## Admin Dashboard

In the admin dashboard, each API key row has an **Edit Rate** button. Clicking it opens a prompt where you can enter a new limit (between 1 and 10000). After confirmation, the page reloads and the new limit is displayed in the table.

The rate limit is also displayed in the dedicated column.

## Defaults

New API keys are created with a default rate limit of 100 requests per minute.

## Performance Note

Reading the rate limit from the database on every request adds a small overhead. For high‑traffic keys, consider caching the value in Redis (future improvement).
