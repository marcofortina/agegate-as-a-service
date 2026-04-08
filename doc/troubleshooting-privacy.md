# Troubleshooting with IP Hashing

## The Challenge

With IP anonymization enabled, you cannot see real client IPs in logs. This document explains how to debug issues without compromising privacy.

## Scenario 1: Rate Limiting Too Aggressive

**Problem**: A legitimate client is being rate-limited.

**Solution**: Check rate limit keys (hashed, not real IP):

```bash
# Redis: see top rate-limited hashes
redis-cli --scan --pattern "rate:*" | head -20
```

If a single hash shows excessive requests, it might be:
- A NAT gateway (many users, same hash)
- A misconfigured client

**Action**: Increase rate limit for that API key (not per IP).

## Scenario 2: DDoS or Abuse

**Problem**: Someone is abusing the API.

**Solution**:
1. Identify the abusive hash from logs
2. Block that hash temporarily
3. Monitor if abuse stops

```javascript
// Add to rate limiter
if (anonymizedIP === 'abusive-hash-here') {
  return res.status(429).json({ error: 'Temporarily blocked' });
}
```

## Scenario 3: Legal Request for User Identification

**Problem**: A judicial authority requests the real IP behind a specific verification.

**Process**:
1. Authority provides the **hash** and **timestamp**
2. Retrieve the salt used on that day
3. Provide salt to authority (under warrant)
4. Authority reverses: `IP = decode(hash, salt)`

**Implementation**:

```javascript
// Internal tool (not exposed publicly!)
const { verifyIP } = require('./proxy');

// For authorized personnel only
function debugIP(ip, hash, date) {
  if (!hasJudicialWarrant()) throw new Error('Unauthorized');
  return verifyIP(ip, hash, date);
}
```

## Scenario 4: Debugging a Specific Client

**Problem**: A client reports issues, and you need to see their requests.

**Solution** (with client cooperation):
1. Client provides their **public IP** (voluntarily)
2. Calculate hash: `hash = sha256(ip + dailySalt)`
3. Search logs for that hash

```bash
# Client says: "My IP is 1.2.3.4"
# Calculate hash (using today's salt)
echo -n "1.2.3.4$(cat /run/secrets/ip_salt)" | sha256sum

# Search logs
grep "a3f5c2d8e1b4c7f9" logs/verification.log
```

## Scenario 5: Salt Rotation Issues

**Problem**: After salt rotation, old hashes no longer match.

**Solution**: Store salt history for 7 days.

```javascript
// In production, store salts in Redis with TTL
const saltHistory = {
  '2026-04-08': 'salt-for-april-8',
  '2026-04-07': 'salt-for-april-7'
};
```

## Scenario 6: Multi-Replica Consistency

**Problem**: Different pod replicas generate different salts, causing inconsistent hashes.

**Solution**: Store salt in Redis (shared across replicas):

```javascript
async function getSharedSalt() {
  const today = new Date().toISOString().split('T')[0];
  const saltKey = `global_salt:${today}`;

  let salt = await redis.get(saltKey);
  if (!salt) {
    salt = crypto.randomBytes(32).toString('hex');
    await redis.setex(saltKey, 86400, salt); // 24 hours
  }
  return salt;
}
```

## Best Practices

1. **Never log real IPs** - even in development (use `.env` to disable anonymization locally)
2. **Rotate salts daily** - limits exposure if salt leaks
3. **Keep salt history for 7 days** - enough for legal requests, not forever
4. **Document warrant process** - have a clear procedure for legal requests
5. **Test hash collisions** - SHA256 is collision-resistant, but monitor anyway
6. **Use Redis for shared salt** - essential for multiple replicas

## Emergency: Disable Anonymization Temporarily

Only in extreme cases (active attack, with legal authorization):

```bash
# Kubernetes
kubectl set env deployment/agegate-verifier ANONYMIZE_IP=false

# Docker
docker run -e ANONYMIZE_IP=false agegate-verifier

# Local dev
ANONYMIZE_IP=false npm start
```

**Remember to re-enable after incident!**

## Monitoring & Alerts

### Detect Anomalies Using Hashes

```promql
# Prometheus query: top rate-limited hashes
topk(10, rate(agegate_rate_limited_total[5m]))
```

### Alert on Sudden Hash Spikes

```yaml
# Prometheus alert rule
- alert: HighRateLimitByHash
  expr: rate(agegate_rate_limited_total[5m]) > 100
  annotations:
    summary: "Hash {{ $labels.hash }} is being rate-limited heavily"
```

## FAQ

**Q: Can two different IPs produce the same hash?**
A: SHA256 collision probability is astronomically low (2^-256). Safe for this use case.

**Q: What if the salt leaks?**
A: Rotate salt immediately. Old hashes become unverifiable (privacy preserved), new hashes use new salt.

**Q: How long do we keep salts?**
A: 7 days default. Long enough for legal requests, short enough to limit exposure.

**Q: Can we still do geolocation?**
A: No. That's by design. EU Blueprint requires double anonymity.

## Related Documents

- [Privacy Implementation](./privacy.md)
- [EU Blueprint Reference](https://ageverification.dev)
- [GDPR Article 25](https://gdpr-info.eu/art-25-gdpr/)
```

---
