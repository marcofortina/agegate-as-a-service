# White‑Label / Client Branding

Age Gate as a Service supports white‑label branding, allowing each client to customise the appearance of the age verification modal.

## Public Endpoint

### `GET /api/v1/branding/:client_id`

Returns the branding settings for a given `client_id`. No authentication required.

**Default response (if no branding is set):**
```json
{
  "client_id": "example.com",
  "logo_url": null,
  "primary_color": "#0a0",
  "secondary_color": "#1a1a1a",
  "custom_domain": null,
  "footer_text": null
}
```

## Admin Endpoints

### `GET /api/v1/branding`

Lists all client brandings.

### `POST /api/v1/branding`

Creates or updates a branding for a client. Expects client_id, logo_url, primary_color, secondary_color, custom_domain, footer_text in JSON body.

### `DELETE /api/v1/branding/:client_id`

Removes the branding for the specified client.

### `GET /api/v1/branding/admin/:client_id`

Retrieves the branding for a single client (for editing).

## Admin Dashboard

In the admin dashboard, under the **Client Branding** card, you can select a client and customise:
- Logo URL
- Primary button color (hex)
- Modal background color (hex)
- Custom domain (for future use)
- Footer text

Additionally, a table lists all existing brandings with Edit and Delete buttons.

## SDK Integration

The JavaScript SDK (`agegate-sdk.js`) automatically fetches the branding for the current domain and applies the colours and logo to the verification modal.

## Custom Domain

To use a custom domain (e.g., `verify.client.com`), you need to configure a reverse proxy (e.g., Ingress) that forwards requests to the Age Gate service and injects the `X-Client-ID` header or maps the domain to a client ID.
