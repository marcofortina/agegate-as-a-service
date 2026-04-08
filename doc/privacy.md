# Privacy & Double Anonymity Implementation

## EU Blueprint Compliance (ageverification.dev)

Age Gate as a Service implements the **double anonymity** requirement from the EU Blueprint:

1. **First level**: We never ask for user's identity (name, email, ID document)
2. **Second level**: We never log or store client IP addresses

## How It Works

### IP Hashing (Oblivious HTTP)

Instead of logging real IP addresses, we:

1. Receive the request with real IP
2. Calculate a **SHA256 hash** of the IP + a **daily rotating salt**
3. Log only the **hash** (not the IP)
4. Forward only the hash to downstream services

```
Real IP: 192.168.1.100
Salt:    daily-salt-2026-04-08
Hash:    a3f5c2d8e1b4... (64 chars)
```

### Salt Rotation

- Salt rotates **daily** automatically
- Old salts are **discarded** after 7 days (configurable)
- Without the salt, the hash cannot be reversed to obtain the original IP

### Troubleshooting & Legal Requests

If a judicial authority requests the real IP for a specific hash:

1. Authority provides the **hash** and **date** of the incident
2. We provide the **salt** used on that specific day
3. Authority can reverse the hash: `IP = decode(hash, salt)`

**Important**: We never store IPs. We only store hashes and rotated salts for 7 days.

## Configuration

### Enable/Disable Anonymization

```yaml
# Helm values
env:
  ANONYMIZE_IP: "true"  # Default: true
  IP_SALT: "your-secret-salt"  # Optional: auto-generated if not set
```

### Development Mode

For debugging in development:

```bash
# Disable anonymization (shows real IPs in logs)
ANONYMIZE_IP=false npm run dev
```

## Logging Example

**Anonymized log (production):**
```json
{
  "level": 30,
  "anonymizedIP": "a3f5c2d8e1b4c7f9...",
  "clientId": "casino-italia.it",
  "verified": true
}
```

**Real IP never appears in logs.**

## Compliance Documentation

- EU Blueprint: [ageverification.dev](https://ageverification.dev)
- AGCOM Guidelines: [agcom.it](https://www.agcom.it)
- GDPR Article 25 (Data Protection by Design)

## Audit

To verify compliance:

```bash
# Check logs for real IPs (should return nothing)
grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' logs/*.log

# Check database for IP columns
psql -d agegate -c "\d verifications" | grep -i ip
```

## Salt Management

```javascript
// Rotate salt daily (automatic)
// Retrieve current salt (for authorized debugging only)
const { getCurrentSalt } = require('./proxy');
console.log(getCurrentSalt()); // Only in development!
```

## Legal Note

This implementation balances:
- **Privacy**: IPs are never stored or logged
- **Security**: Rate limiting still works using hashes
- **Accountability**: Judicial authorities can still trace abuse with proper warrant

**Never share salts publicly. Rotate them regularly.**

## Technical Details

### Hash Algorithm

```javascript
const crypto = require('crypto');
const hash = crypto.createHash('sha256').update(ip + salt).digest('hex');
```

### Salt Storage

In production with multiple replicas, store salts in Redis:

```javascript
const saltKey = `salt:${date}`;
const salt = await redis.get(saltKey) || generateNewSalt();
await redis.setex(saltKey, 7 * 86400, salt); // 7 days TTL
```

### Rate Limiting with Hashes

```javascript
const rateKey = `rate:${apiKey}:${anonymizedIP}`;
// Same effective rate limiting, but without knowing real IPs
```

## Verification Checklist for Auditors

- [ ] No IP addresses in application logs
- [ ] No IP columns in database tables
- [ ] Salt rotation is automated (daily)
- [ ] Old salts are deleted after retention period
- [ ] Rate limiting uses hashed keys, not raw IPs
- [ ] Documentation of legal warrant process exists

## Related Documents

- [Troubleshooting with IP Hashing](./troubleshooting-privacy.md)
- [EU Blueprint Reference](https://ageverification.dev)
- [GDPR Compliance Guide](https://gdpr-info.eu)
