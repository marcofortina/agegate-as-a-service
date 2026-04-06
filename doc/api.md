# API Reference

## POST /verify

Header: `x-api-key`
Body: `{ 'client_id': '...', 'threshold': 18 }`

Response (success):
```json
{
  "status": "success",
  "message": "Age ≥ 18 successfully verified...",
  "verified": true
}
```

## Other endpoints

- `GET /dashboard` (admin only)
- `GET /onboarding` (public)
- `GET /metrics` (admin only)
- `GET /health`
- `GET /ready`
