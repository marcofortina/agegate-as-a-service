# Webhook Notifications

## Overview

Age Gate as a Service can send asynchronous HTTP POST notifications to a configured URL each time an age verification is completed.

## Configuration (Admin only)

Use the `POST /api/v1/webhook` endpoint to register or update a webhook URL for a specific client.

### Request

```bash
curl -X POST https://agegate.example.com/api/v1/webhook \
  -u admin:password \
  -H "Content-Type: application/json" \
  -d '{"client_id": "example.com", "url": "https://your-server.com/callback"}'
```

### Response

```json
{
  "success": true,
  "client_id": "example.com",
  "url": "https://your-server.com/callback"
}
```

To remove a webhook, use `DELETE /api/v1/webhook/:client_id`.

## Webhook Payload

## Admin Dashboard UI

In the admin dashboard, there is a **Webhook Management** card that lists all registered webhooks (client ID, URL, creation/update timestamps). You can:
- Add a new webhook by clicking **Add Webhook** and entering client ID and URL.
- Delete an existing webhook using the **Delete** button next to each entry.

The dashboard uses the same API endpoints (`GET /api/v1/webhooks`, `POST /api/v1/webhook`, `DELETE /api/v1/webhook/:client_id`) under the hood.

## Payload Format

When a verification is completed (successful or not), a POST request is sent to the registered URL with the following JSON body:

```json
{
  "event": "verification.completed",
  "client_id": "example.com",
  "verified": true,
  "threshold": 18,
  "timestamp": "2026-04-10T12:00:00.000Z",
  "proofType": "mock"
}
```

The webhook is sent **asynchronously** and does not block the verification response. Errors are logged but not retried (future improvement).

## Security Considerations

Webhook URLs should use HTTPS in production to ensure confidentiality. The request is not signed; future versions may add HMAC signatures.
