// proxy.js - Middleware for anonymous IP hashing
const crypto = require('crypto');

let redisClient = null;

// Salt that rotates daily (or per request)
let currentSalt = null;
let saltExpiry = null;

function getCurrentSalt() {
  const now = new Date();
  const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

  if (!currentSalt || saltExpiry !== today) {
    // In production, read from env or Redis for multi-replica consistency
    currentSalt = process.env.IP_SALT || crypto.randomBytes(32).toString('hex');
    saltExpiry = today;

    // Log salt change (but not the salt itself!)
    console.log(`[PROXY] IP salt rotated for ${today}`);
  }
  return currentSalt;
}

/**
 * For multi-replica deployments: store salt in Redis
 * Call this once after Redis connection is established
 */
function setRedisClient(client) {
  redisClient = client;
}

async function getSharedSalt() {
  if (!redisClient) {
    // Fallback to in-memory salt
    return getCurrentSalt();
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const saltKey = `global_salt:${today}`;

  let salt = await redisClient.get(saltKey);
  if (!salt) {
    salt = process.env.IP_SALT || crypto.randomBytes(32).toString('hex');
    // Expire after 25 hours (gives 1 hour overlap for day change)
    await redisClient.setex(saltKey, 25 * 3600, salt);
    console.log(`[PROXY] New salt stored in Redis for ${today}`);
  }

  return salt;
}

/**
 * Generate an anonymous hash from IP address
 * @param {string} ip - The real client IP
 * @param {string} salt - Optional custom salt
 * @returns {Promise<string>} SHA256 hash
 */
async function hashIP(ip, salt = null) {
  let effectiveSalt;
  if (salt) {
    effectiveSalt = salt;
  } else if (redisClient) {
    effectiveSalt = await getSharedSalt();
  } else {
    effectiveSalt = getCurrentSalt();
  }
  return crypto.createHash('sha256').update(ip + effectiveSalt).digest('hex');
}

/**
 * Express middleware that replaces real IP with hash
 * @param {Object} options - Configuration options
 * @param {boolean} options.enabled - Enable/disable anonymization (default: true)
 * @param {boolean} options.passthroughOnError - If true, passes real IP on error (for debugging)
 */
function anonymizeIPMiddleware(options = {}) {
  const enabled = options.enabled !== false;
  const passthroughOnError = options.passthroughOnError || false;

  return async (req, res, next) => {
    if (!enabled) {
      // Debug mode: pass real IP in a special header (not logged!)
      req.realIP = req.ip;
      req.anonymizedIP = req.ip;
      return next();
    }

    try {
      // Get real client IP (handles proxies, X-Forwarded-For, etc.)
      const realIP = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                     req.socket.remoteAddress ||
                     req.ip;

      // Generate hash
      const ipHash = await hashIP(realIP);

      // Store both (hash for logging, real only for immediate rate limiting if needed)
      req.realIP = realIP; // Never log this!
      req.anonymizedIP = ipHash;

      // Add hash to headers for downstream services
      req.headers['x-anonymized-ip'] = ipHash;
      req.headers['x-forwarded-ip-hash'] = ipHash;

      // Remove original IP headers to prevent logging
      delete req.headers['x-forwarded-for'];

      next();
    } catch (err) {
      console.error('[PROXY] Failed to anonymize IP:', err.message);

      if (passthroughOnError) {
        req.anonymizedIP = req.ip;
        next();
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };
}

/**
 * Utility to verify a hash given an IP and optional date
 * (For debugging/troubleshooting with judicial authorization)
 */
async function verifyIP(ip, hash, date = null) {
  let salt;

  if (date) {
    // Reconstruct salt for that specific date
    const targetDate = new Date(date).toISOString().split('T')[0];
    salt = process.env.IP_SALT || `fixed-salt-${targetDate}`;
  } else {
    salt = getCurrentSalt();
  }

  const computedHash = await hashIP(ip, salt);
  return computedHash === hash;
}

module.exports = {
  anonymizeIPMiddleware,
  hashIP,
  verifyIP,
  getCurrentSalt,
  getSharedSalt,
  setRedisClient
};
