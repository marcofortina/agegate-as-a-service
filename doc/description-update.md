# Updating API Key Description

Administrators can update the description of an existing API key without revoking or rotating it.

## Endpoint

### `PATCH /api/v1/keys/:api_key/description`

**Authentication:** Admin (Basic Auth)

**Request body:**
```json
{
  "description": "New description text (max 255 characters)"
}
```

**Response:**
```json
{
  "success": true,
  "client_id": "example.com",
  "description": "New description text"
}
```

**Error responses:**
- `400` – Invalid input (description missing or not a string)
- `401` – Unauthorized
- `404` – API key not found

## Admin Dashboard

In the dashboard, each API key row includes an **Edit Desc** button. Clicking it opens a prompt to modify the description.

## Audit Log

Every description update is logged in `admin_audit_log` with action `UPDATE_DESCRIPTION`.

## Security

Only admin users can change descriptions. The endpoint validates that the description is a string and trims it to 255 characters.
