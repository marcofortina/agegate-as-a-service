# API Key Expiry Notification

Age Gate as a Service automatically sends email reminders to clients when their API key is about to expire (30 days before expiry).

## How it works

A daily cron job (scheduled at 9:00 AM server time) checks for API keys that will expire within the next 30 days and have not yet received a notification. An email is sent to the `contact_email` associated with the key.

## Configuration

Email sending requires SMTP settings (see `.env.example`). Notifications are enabled only if SMTP is configured.

## Client experience

The client receives an email with:
- Client ID
- Expiration date
- Number of days left
- Link to the client dashboard to rotate the key

## Admin endpoints

When registering a client via `POST /api/v1/register`, you can optionally provide an `email` field. For self‑onboarding (`POST /api/v1/register/public`), the email is mandatory.

## Disabling notifications

To disable expiry notifications, simply remove SMTP configuration or set `SMTP_HOST` to an empty value.
