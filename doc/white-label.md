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

## Admin Dashboard

In the admin dashboard, under the **Client Branding** card, you can select a client and customise:
- Logo URL
- Primary button color (hex)
- Modal background color (hex)
- Custom domain (for future use)
- Footer text

## SDK Integration

The JavaScript SDK (`agegate-sdk.js`) automatically fetches the branding for the current domain and applies the colours and logo to the verification modal.

## Custom Domain

To use a custom domain (e.g., `verify.client.com`), you need to configure a reverse proxy (e.g., Ingress) that forwards requests to the Age Gate service and injects the `X-Client-ID` header or maps the domain to a client ID.
