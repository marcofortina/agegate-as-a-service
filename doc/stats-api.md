# Statistics API Endpoint

## `GET /stats`

Returns verification statistics for the authenticated client.

### Authentication

Same as `/verify` – provide your API key in the `x-api-key` header.

### Example Request

```bash
curl -H "x-api-key: agk_..." https://agegate.yourdomain.com/stats
```

### Response (200 OK)

```json
{
  "client_id": "casino-italia.it",
  "total_verifications": 1240,
  "successful_verifications": 1178,
  "success_rate": 95.0,
  "last_verification": "2026-04-08T14:30:00.000Z",
  "daily_breakdown": [
    { "date": "2026-04-08", "verifications": 320 },
    { "date": "2026-04-07", "verifications": 298 },
    { "date": "2026-04-06", "verifications": 310 }
  ]
}
```

### Errors

| Status | Meaning |
|--------|---------|
| 401 | Missing, invalid, expired, or revoked API key |
| 429 | Rate limit exceeded (100 requests per minute) |
| 500 | Internal server error |

### Rate Limiting

The `/stats` endpoint is limited to **100 requests per minute** per API key (to prevent abuse).

### Usage Example (Client Side)

You can call this endpoint from your backend to monitor your verification usage. It's useful for billing or internal dashboards.
