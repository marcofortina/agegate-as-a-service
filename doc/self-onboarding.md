# Client Self‑Onboarding (Public Registration)

New clients can register themselves and obtain an API key without contacting an administrator. The key is sent to their email address.

## Public Registration Page

Accessible at `GET /register`. The form asks for:
- Client ID (e.g., yourdomain.com)
- Email address
- Description (optional)
- Age threshold (default 18)

After submission, an API key is generated and an email is sent to the provided address.

## API Endpoint

### `POST /api/v1/register/public` (CSRF protected)

**Request body:**
```json
{
  "client_id": "example.com",
  "email": "admin@example.com",
  "description": "My website",
  "threshold": 18
}
```

**Response:**
```json
{
  "success": true,
  "message": "Registration successful. API key has been sent to your email.",
  "client_id": "example.com",
  "api_key": "agk_...",
  "expires_at": "2027-04-12T12:00:00.000Z"
}
```

## Rate Limiting

To prevent abuse, only **3 registration attempts per IP per hour** are allowed.

## Email Configuration

Set the following environment variables to enable email sending:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`
- `FROM_EMAIL` (sender address)
