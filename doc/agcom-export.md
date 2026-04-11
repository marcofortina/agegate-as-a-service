# AGCOM Compliance Export

Administrators can generate a report of verification data that complies with AGCOM guidelines (anonymous, aggregated data).

## Endpoint

`GET /api/v1/export/compliance` (admin only, CSRF protected)

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `format` | string | `csv` or `pdf` (required) |
| `client_id` | string | Filter by specific client (optional) |
| `from` | date | Start date (YYYY-MM-DD) (optional) |
| `to` | date | End date (YYYY-MM-DD) (optional) |

### Response

A file download (CSV or PDF) containing the following aggregated fields per client per day:

- Client ID
- Date
- Total verifications
- Successful verifications
- Success rate
- Average threshold

No IP addresses or personally identifiable information are included.

## Admin Dashboard

In the admin dashboard, there is a **AGCOM Compliance Export** card with:

- Format selector (CSV/PDF)
- Optional client ID filter
- Optional date range
- Export button

The report is generated based on the `verifications` table.

## Notes

The report is intended for internal compliance and auditing purposes. It does not include any sensitive data.
