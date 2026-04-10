# Client Self‑Service Dashboard

Clients can access a dedicated dashboard to view their verification statistics and manage their API key without admin privileges.

## Access

The dashboard is available at `GET /client/dashboard`. Authentication is performed via the `x-api-key` header.

Example using `curl`:
```bash
curl -H "x-api-key: agk_..." http://agegate.local/client/dashboard
```

The response is an HTML page that shows:
- Total and successful verifications
- Success rate
- Last verification timestamp
- Current description of the API key
- Buttons to rotate the key and update the description

## API Endpoints for Clients

### `GET /client/description`
Returns the current description of the API key.

**Request header:** `x-api-key: <your-key>`

**Response:**
```json
{ "description": "My website" }
```

### `PATCH /client/description`
Updates the description of the API key.

**Request body:**
```json
{ "description": "New description" }
```

**Response:**
```json
{ "success": true, "description": "New description" }
```

### `POST /client/rotate`
Generates a new API key and revokes the current one. The new key is returned in the response. The old key becomes invalid immediately.

**Response:**
```json
{
  "client_id": "example.com",
  "api_key": "agk_new...",
  "expires_at": "2027-04-10T12:00:00.000Z"
}
```
