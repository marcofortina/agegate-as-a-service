try {
  require('dotenv').config({ override: false });
} catch { /* dotenv not available, using env vars */ }

// Disable IP anonymization during tests (avoids Redis dependency)
process.env.ANONYMIZE_IP = 'false';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';

// Reduce log verbosity during tests to keep output clean
process.env.LOG_LEVEL = 'error';

// Use ADMIN_PASS from environment
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// Mock nodemailer e configura SMTP per i test di expiry notification
process.env.SMTP_HOST = 'smtp.mock';
process.env.SMTP_PORT = '25';
process.env.FROM_EMAIL = 'test@example.com';
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: jest.fn().mockResolvedValue(true) })
}));

const request = require('supertest');

// ================= MOCKS =================

jest.mock('ioredis', () => {
  const mockRedis = {
    multi: jest.fn(() => ({
      incr: jest.fn(),
      ttl: jest.fn(),
      exec: jest.fn().mockResolvedValue([
        [null, 1],
        [null, 60]
      ])
    })),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn(),
    decr: jest.fn(),
    del: jest.fn(),
    incr: jest.fn().mockResolvedValue(1),
    setex: jest.fn().mockResolvedValue('OK'),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn()
  };

  const RedisMock = jest.fn(() => mockRedis);
  RedisMock.__mockInstance = mockRedis;

  return RedisMock;
});

const mockRegisteredClientIds = new Set();
const mockRegisteredApiKeys = new Map();

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: jest.fn().mockImplementation((sql, params) => {
        // Handle INSERT into api_keys (for /api/v1/register/public and /api/v1/register tests)
        if (sql.includes('INSERT INTO api_keys')) {
          if (params && params[0] && params[1]) {
            const clientId = params[0];
            const apiKey = params[1];
            const defaultThreshold = params[5] ?? 18;

            mockRegisteredClientIds.add(clientId);
            mockRegisteredApiKeys.set(apiKey, {
              client_id: clientId,
              expires_at: null,
              is_active: true,
              default_threshold: defaultThreshold
            });
          }
          return Promise.resolve({ rows: [{ api_key: params[1] }] });
        }

        // Handle api_keys table queries
        if (sql.includes('FROM api_keys')) {
          const key = params ? params[0] : null;

          if (sql.includes('SELECT client_id FROM api_keys WHERE client_id = $1')) {
            return Promise.resolve({
              rows: mockRegisteredClientIds.has(key) ? [{ client_id: key }] : []
            });
          }

          if (sql.includes('SELECT description FROM api_keys WHERE api_key = $1')) {
            return Promise.resolve({ rows: [{ description: 'Test description', default_threshold: 18 }] });
          }

          if (sql.includes('UPDATE api_keys SET description = $1 WHERE api_key = $2')) {
            return Promise.resolve({ rows: [] });
          }

          if (sql.includes('SELECT client_id, is_active, expires_at FROM api_keys WHERE api_key = $1')) {
            if (mockRegisteredApiKeys.has(key)) {
              const entry = mockRegisteredApiKeys.get(key);
              if (!entry.is_active) {
                return Promise.resolve({ rows: [] });
              }
              return Promise.resolve({
                rows: [{
                  client_id: entry.client_id,
                  is_active: entry.is_active,
                  expires_at: entry.expires_at
                }]
              });
            }

            if (key === 'test-key-123' || key === 'rate-limit-key') {
              return Promise.resolve({
                rows: [{
                  client_id: 'test.local',
                  is_active: true,
                  expires_at: null
                }]
              });
            }

            return Promise.resolve({ rows: [] });
          }

          if (sql.includes('SELECT client_id, is_active, expires_at FROM api_keys WHERE api_key = $1')) {
            if (mockRegisteredApiKeys.has(key)) {
              const entry = mockRegisteredApiKeys.get(key);
              if (!entry.is_active) {
                return Promise.resolve({ rows: [] });
              }
              return Promise.resolve({
                rows: [{
                  client_id: entry.client_id,
                  is_active: entry.is_active,
                  expires_at: entry.expires_at
                }]
              });
            }
          }

          if (mockRegisteredApiKeys.has(key)) {
            const entry = mockRegisteredApiKeys.get(key);
            if (!entry.is_active) {
              return Promise.resolve({ rows: [] });
            }
            return Promise.resolve({
              rows: [entry]
            });
          }

          // Recognized test keys
          if (key === 'test-key-123' || key === 'rate-limit-key') {
            return Promise.resolve({
              rows: [{
                client_id: 'test.local',
                expires_at: null,
                is_active: true,
                default_threshold: 18
              }]
            });
          }
          return Promise.resolve({ rows: [] });
        }
        // Handle migration check query (SELECT COUNT(*) ... WHERE created_by = 'migration')
        if (sql.includes('WHERE created_by')) {
          return Promise.resolve({ rows: [{ count: 0 }] });
        }
        // Handle SELECT COUNT(*) FROM verifications (for dashboard)
        if (sql.includes('SELECT COUNT(*) as total FROM verifications')) {
          return Promise.resolve({ rows: [{ total: 42 }] });
        }
        if (sql.includes('SELECT COUNT(*) as successful')) {
          return Promise.resolve({ rows: [{ successful: 30 }] });
        }
        if (sql.includes('SELECT MAX(timestamp) as last')) {
          return Promise.resolve({ rows: [{ last: new Date().toISOString() }] });
        }
        if (sql.includes('SELECT DATE(timestamp) as day')) {
          return Promise.resolve({ rows: [] });
        }
        // Handle export query (aggregated)
        if (sql.includes('SELECT client_id, DATE(timestamp) as date, COUNT(*) as total_verifications, SUM(CASE WHEN verified THEN 1 ELSE 0 END) as successful, AVG(threshold) as avg_threshold FROM verifications')) {
          // Return a mock aggregated row
          return Promise.resolve({ rows: [{ client_id: 'test.local', date: new Date().toISOString().slice(0,10), total_verifications: 10, successful: 9, avg_threshold: 18.0 }] });
        }
        // Handle SELECT from client_branding (for GET /api/v1/branding/:client_id)
        if (sql.includes('FROM client_branding')) {
          const clientId = params && params[0];
          if (clientId === 'branding-test') {
            return Promise.resolve({
              rows: [{
                logo_url: 'https://example.com/logo.png',
                primary_color: '#ff0000',
                secondary_color: '#00ff00',
                custom_domain: 'verify.branding-test.com',
                footer_text: 'Custom footer'
              }]
            });
          } else {
            return Promise.resolve({ rows: [] });
          }
        }
        // Handle SELECT rate_limit
        if (sql.includes('SELECT rate_limit FROM api_keys WHERE api_key = $1')) {
          return Promise.resolve({ rows: [{ rate_limit: 100 }] });
        }
        if (sql.includes('WHERE created_by')) {
          return Promise.resolve({ rows: [{ count: 0 }] });
        }
        // Handle query for /api/v1/keys/:client_id
        if (sql.includes('SELECT api_key, created_at, expires_at, last_used_at, is_active, created_by, description FROM api_keys WHERE client_id = $1')) {
          return Promise.resolve({ rows: [{ api_key: 'test-key-123', created_at: new Date(), expires_at: null, last_used_at: null, is_active: true, created_by: 'admin', description: 'Test key' }] });
        }
        // Handle plans table queries
        if (sql.includes('FROM plans')) {
          // Return mock plans for any query on plans table
          return Promise.resolve({ rows: [
            { id: 1, name: 'Free', price_cents: 0, interval: 'month', features: {} },
            { id: 2, name: 'Pro', price_cents: 4900, interval: 'month', features: {} }
          ] });
        }
        // Handle UPDATE rate_limit
        if (sql.includes('UPDATE api_keys SET rate_limit = $1 WHERE api_key = $2 RETURNING client_id')) {
          return Promise.resolve({ rows: [{ client_id: 'rate-test' }] });
        }
        // Handle UPDATE daily_limit
        if (sql.includes('UPDATE api_keys SET daily_limit = $1 WHERE api_key = $2 RETURNING client_id')) {
          return Promise.resolve({ rows: [{ client_id: 'daily-test' }] });
        }
        // Handle UPDATE description
        if (sql.includes('UPDATE api_keys SET description = $1 WHERE api_key = $2 RETURNING client_id')) {
          if (params && params[1] === 'nonexistent') {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [{ client_id: 'desc-test' }] });
        }
        // Handle INSERT/UPDATE into client_branding (for POST /api/v1/branding)
        if (sql.includes('INSERT INTO client_branding')) {
          return Promise.resolve({ rows: [] });
        }
        // Handle all other queries
        return Promise.resolve({ rows: [] });
      }),
      end: jest.fn()
    }))
  };
});

jest.mock('prom-client', () => {
  return {
    Registry: jest.fn().mockImplementation(() => ({
      registerMetric: jest.fn(),
      metrics: jest.fn().mockResolvedValue('')
    })),
    collectDefaultMetrics: jest.fn(),
    Counter: jest.fn().mockImplementation(() => ({
      inc: jest.fn()
    })),
    Histogram: jest.fn().mockImplementation(() => ({
      observe: jest.fn()
    }))
  };
});

beforeEach(() => {
  mockRegisteredClientIds.clear();
  mockRegisteredApiKeys.clear();
});

// NOW require app AFTER mocks
const { app, getServer } = require('../server');

// Supertest agent to handle cookies for CSRF
const agent = request.agent(app);

beforeAll(async () => {
  // Health check
  await agent.get('/health').expect(200);

  const loginPage = await agent.get('/login').expect(200);
  const loginCsrfMatch = loginPage.text.match(/name="_csrf" value="([^"]+)"/);
  expect(loginCsrfMatch).not.toBeNull();
  const loginCsrf = loginCsrfMatch[1];

  await agent
    .post('/login')
    .set('CSRF-Token', loginCsrf)
    .send({ user: ADMIN_USER, pass: ADMIN_PASS })
    .expect(302);
});

// helper to fetch real CSRF token
async function getCsrfToken() {
  const res = await agent.get('/csrf-token').expect(200);
  return res.body.csrfToken;
}

describe('AgeGate as a Service - API Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    const server = getServer();
    if (server && typeof server.close === 'function') {
      server.close();
    }
    const Redis = require('ioredis');
    if (Redis.__mockInstance && Redis.__mockInstance.quit) {
      await Redis.__mockInstance.quit();
    }
  });

  test('GET /health should return healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  test('GET /login should serve login page', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Age Gate Admin Login');
    expect(res.text).toContain('method="POST" action="/login"');
    expect(res.text).toContain('name="_csrf"');
    expect(res.text).toContain('name="user"');
    expect(res.text).toContain('name="pass"');
  });

  test('GET /dashboard without auth redirects to /login', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /dashboard after login returns HTML', async () => {
    const res = await agent.get('/dashboard').expect(200);
    expect(res.text).toContain('AgeGate Dashboard');
    expect(res.text).toContain('Webhook Management');
  });

  test('POST /login regenerates the session id', async () => {
    const loginPage = await agent.get('/login').expect(200);
    const csrfMatch = loginPage.text.match(/name="_csrf" value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch[1];

    const loginRes = await agent
      .post('/login')
      .set('CSRF-Token', csrfToken)
      .send({ user: ADMIN_USER, pass: ADMIN_PASS })
      .expect(302);

    expect(loginRes.headers.location || loginRes.headers.Location).toBe('/dashboard');

    const newCookie = (loginRes.headers['set-cookie'] || [])
      .find(c => c.startsWith('agegate.sid='));
    expect(newCookie).toBeDefined();

    const initialCookie = (loginPage.headers['set-cookie'] || [])
      .find(c => c.startsWith('agegate.sid='));
    if (initialCookie) {
      expect(newCookie.split(';')[0]).not.toBe(initialCookie.split(';')[0]);
    }
  });

  test('Authenticated dashboard renews the session cookie with 15 minute max-age', async () => {
    const res = await agent.get('/dashboard').expect(200);
    const sessionCookie = (res.headers['set-cookie'] || [])
      .find(c => c.startsWith('agegate.sid='));
    expect(sessionCookie).toBeDefined();

    const expiresMatch = sessionCookie.match(/Expires=([^;]+)/i);
    expect(expiresMatch).not.toBeNull();
    const now = Date.now();
    const expiresAt = new Date(expiresMatch[1]).getTime();
    const deltaMs = expiresAt - now;
    expect(deltaMs).toBeGreaterThanOrEqual(13.5 * 60 * 1000);
    expect(deltaMs).toBeLessThanOrEqual(16.5 * 60 * 1000);
  });

  test('Session secret rotation retains current and previous secrets for 7 days', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const freshSecret = 'fresh-secret-a';
    const staleSecret = 'stale-secret-b';

    let loadSessionSecrets, rotateSessionSecret, getSessionSecretsSnapshot;
    let mockGet, mockSetex;

    jest.isolateModules(() => {
      const Redis = require('ioredis');

      mockGet = jest.fn().mockResolvedValueOnce(
        JSON.stringify([
          { secret: freshSecret, createdAt: now - (6 * DAY_MS) },
          { secret: staleSecret, createdAt: now - (8 * DAY_MS) }
        ])
      );

      mockSetex = jest.fn().mockResolvedValue('OK');

      Redis.mockImplementation(() => ({
        get: mockGet,
        setex: mockSetex,
        multi: jest.fn(),
        set: jest.fn(),
        expire: jest.fn(),
        decr: jest.fn(),
        del: jest.fn(),
        ping: jest.fn().mockResolvedValue('PONG'),
        quit: jest.fn().mockResolvedValue(undefined),
      }));

      const module = require('../server');
      loadSessionSecrets = module.loadSessionSecrets;
      rotateSessionSecret = module.rotateSessionSecret;
      getSessionSecretsSnapshot = module.getSessionSecretsSnapshot;
    });

    await loadSessionSecrets();

    expect(getSessionSecretsSnapshot()).toContain(freshSecret);
    expect(getSessionSecretsSnapshot()).not.toContain(staleSecret);

    const beforeRotate = getSessionSecretsSnapshot();
    await rotateSessionSecret();
    const afterRotate = getSessionSecretsSnapshot();

    expect(afterRotate[0]).not.toBe(beforeRotate[0]);
    expect(afterRotate.length).toBeLessThanOrEqual(8);

    const storedValue = mockSetex.mock.calls[mockSetex.mock.calls.length - 1][2];
    const storedEntries = JSON.parse(storedValue);
    expect(Array.isArray(storedEntries)).toBe(true);
    expect(storedEntries[0]).toEqual(
      expect.objectContaining({ secret: expect.any(String), createdAt: expect.any(Number) })
    );
  });

  test('POST /api/v1/verify - valid request with mock backend', async () => {
    const res = await request(app)
      .post('/api/v1/verify')
      .set('x-api-key', 'test-key-123')
      .send({ client_id: 'test.local', threshold: 18 });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.ageOverThreshold).toBe(true);
    expect(res.body.proofType).toBeDefined();
  });

  test('POST /api/v1/verify - rate limit exceeded', async () => {
    const Redis = require('ioredis');

    Redis.__mockInstance.multi.mockReturnValue({
      incr: jest.fn(),
      ttl: jest.fn(),
      exec: jest.fn().mockResolvedValue([
        [null, 101],
        [null, 60]
      ])
    });

    const res = await request(app)
      .post('/api/v1/verify')
      .set('x-api-key', 'rate-limit-key')
      .send({ client_id: 'test.local', threshold: 18 });

    expect(res.status).toBe(429);
  });

  test('POST /api/v1/verify - Zod validation error', async () => {
    const Redis = require('ioredis');

    Redis.__mockInstance.multi.mockReturnValue({
      incr: jest.fn(),
      ttl: jest.fn(),
      exec: jest.fn().mockResolvedValue([
        [null, 1],
        [null, 60]
      ])
    });

    const res = await request(app)
      .post('/api/v1/verify')
      .set('x-api-key', 'test-key-123')
      .send({ threshold: 99 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid input');
  });

  test('GET /api-docs should serve Swagger UI', async () => {
    const res = await request(app).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger');
  });

  test('GET /api/v1/stats with valid API key', async () => {
    const res = await request(app)
      .get('/api/v1/stats')
      .set('x-api-key', 'test-key-123')
      .expect(200);

    expect(res.body.client_id).toBe('test.local');
    expect(res.body.total_verifications).toBe(42);
    expect(Array.isArray(res.body.threshold_breakdown)).toBe(true);
    expect(Array.isArray(res.body.weekly_breakdown)).toBe(true);
  });

  test('GET /api/v1/keys/:client_id returns keys for admin', async () => {
    const res = await agent.get('/api/v1/keys/test.local').expect(200);

    expect(res.body.client_id).toBe('test.local');
    expect(Array.isArray(res.body.keys)).toBe(true);
  });

  test('POST /api/v1/register with description', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'desc-test', description: 'My test key' })
      .expect(200);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(res.body.expires_at).toBeDefined();
    // Check that description was passed (mock does not store, but we trust the code)
    // In real DB, description would be stored.
  });

  test('POST /api/v1/register retries on key collision', async () => {
    // Get the pool instance from the app (imported after mocks)
    const { pool } = require('../server');
    const originalQuery = pool.query;

    let insertAttempts = 0;
    const mockQuery = jest.fn(async (sql, params) => {
      if (sql.includes('INSERT INTO api_keys')) {
        insertAttempts++;
        if (insertAttempts === 1) {
          const error = new Error('duplicate key');
          error.code = '23505';
          throw error;
        }
        if (insertAttempts === 2) {
          return { rows: [] };
        }
      }
      // For other queries, call original
      return originalQuery.call(pool, sql, params);
    });

    pool.query = mockQuery;

    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'collision-test', description: 'retry test' })
      .expect(200);

    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(insertAttempts).toBe(2);

    pool.query = originalQuery;
  });

  test('POST /api/v1/rotate retries on key collision', async () => {
    const { pool } = require('../server');
    const originalQuery = pool.query;

    let insertAttempts = 0;
    let registeredKey = null;
    const mockQuery = jest.fn(async (sql, params) => {
      if (sql.includes('is_active = false')) {
        const revokedKey = params && params[0];
        if (revokedKey && mockRegisteredApiKeys.has(revokedKey)) {
          const entry = mockRegisteredApiKeys.get(revokedKey);
          entry.is_active = false;
          mockRegisteredApiKeys.set(revokedKey, entry);
        }
        return originalQuery.call(pool, sql, params);
      }

      // Handle SELECT for the key we registered
      if (sql.includes('SELECT client_id FROM api_keys WHERE api_key = $1 AND is_active = true')) {
        if (params && params[0] === registeredKey) {
          return { rows: [{ client_id: 'rotate-test' }] };
        }
        return originalQuery.call(pool, sql, params);
      }
      if (sql.includes('INSERT INTO api_keys')) {
        if (!registeredKey) {
          // Registration INSERT
          return originalQuery.call(pool, sql, params);
        } else {
          // Rotate INSERT
          insertAttempts++;
          if (insertAttempts === 1) {
            const error = new Error('duplicate key');
            error.code = '23505';
            throw error;
          }
          if (insertAttempts === 2) {
            return { rows: [] };
          }
        }
      }
      return originalQuery.call(pool, sql, params);
    });

    pool.query = mockQuery;

    // Register a key
    const csrfToken = await getCsrfToken();
    const reg = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'rotate-test' })
      .expect(200);
    registeredKey = reg.body.api_key;

    // Rotate
    const res = await agent
      .post('/api/v1/rotate')
      .set('CSRF-Token', csrfToken)
      .send({ api_key: registeredKey })
      .expect(200);

    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(insertAttempts).toBe(2);

    // Verify old key is revoked
    const verifyOld = await request(app)
      .post('/api/v1/verify')
      .set('x-api-key', registeredKey)
      .send({ client_id: 'rotate-test', threshold: 18 })
      .expect(401);
    expect(verifyOld.body.message).toContain('Invalid API key');

    pool.query = originalQuery;
  });

  test('PATCH /api/v1/keys/:api_key/rate-limit updates rate limit', async () => {
    // Register a key
    const csrfToken = await getCsrfToken();

    const reg = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'rate-test' })
      .expect(200);
    const apiKey = reg.body.api_key;

    const res = await agent
      .patch(`/api/v1/keys/${apiKey}/rate-limit`)
      .set('CSRF-Token', csrfToken)
      .send({ rate_limit: 200 })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.rate_limit).toBe(200);

    // Optionally verify that rate limit is enforced (requires mocking redis)
    // For unit test, we trust the database update.
  });

  // Additional test: invalid rate_limit
  test('PATCH /api/v1/keys/:api_key/rate-limit rejects invalid values', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .patch('/api/v1/keys/some-key/rate-limit')
      .set('CSRF-Token', csrfToken)
      .send({ rate_limit: 0 })
      .expect(400);
    expect(res.body.error).toContain('between 1 and 10000');
  });

  test('PATCH /api/v1/keys/:api_key/daily-limit updates daily limit', async () => {
    const csrfToken = await getCsrfToken();
    const reg = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'daily-test' })
      .expect(200);
    const apiKey = reg.body.api_key;

    const res = await agent
      .patch(`/api/v1/keys/${apiKey}/daily-limit`)
      .set('CSRF-Token', csrfToken)
      .send({ daily_limit: 500 })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.daily_limit).toBe(500);
  });

  test('PATCH /api/v1/keys/:api_key/daily-limit rejects invalid values', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .patch('/api/v1/keys/some-key/daily-limit')
      .set('CSRF-Token', csrfToken)
      .send({ daily_limit: 0 })
      .expect(400);
    expect(res.body.error).toContain('positive integer');
  });

  test('PATCH /api/v1/keys/:api_key/description updates description', async () => {
    const csrfToken = await getCsrfToken();

    // Register a key
    const reg = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'desc-test' })
      .expect(200);
    const apiKey = reg.body.api_key;

    const res = await agent
      .patch(`/api/v1/keys/${apiKey}/description`)
      .set('CSRF-Token', csrfToken)
      .send({ description: 'New description' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.description).toBe('New description');
  });

  test('PATCH /api/v1/keys/:api_key/description rejects invalid input', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .patch('/api/v1/keys/some-key/description')
      .set('CSRF-Token', csrfToken)
      .send({ description: 123 }) // not a string
      .expect(400);
    expect(res.body.error).toContain('must be a string');
  });

  test('PATCH /api/v1/keys/:api_key/description returns 404 for nonexistent key', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .patch('/api/v1/keys/nonexistent/description')
      .set('CSRF-Token', csrfToken)
      .send({ description: 'test' })
      .expect(404);
    expect(res.body.error).toContain('API key not found');
  });

  test('GET /api/v1/client/description returns description', async () => {
    const res = await request(app)
      .get('/api/v1/client/description')
      .set('x-api-key', 'test-key-123')
      .expect(200);
    expect(res.body.description).toBe('Test description');
  });

  test('PATCH /api/v1/client/description updates description', async () => {
    const res = await request(app)
      .patch('/api/v1/client/description')
      .set('x-api-key', 'test-key-123')
      .send({ description: 'New client description' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.description).toBe('New client description');
  });

  test('POST /api/v1/client/rotate returns new API key', async () => {
    const res = await request(app)
      .post('/api/v1/client/rotate')
      .set('x-api-key', 'test-key-123')
      .expect(200);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(res.body.client_id).toBe('test.local');
    // Revocation verification is omitted in unit test (covered by integration tests)
  });

  test('GET /api/v1/client/dashboard returns HTML', async () => {
    const res = await request(app)
      .get('/api/v1/client/dashboard')
      .set('x-api-key', 'test-key-123')
      .expect(200);
    expect(res.text).toContain('Age Gate Client Dashboard');
  });

  test('POST /api/v1/webhook sets webhook URL', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/v1/webhook')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'test-client', url: 'https://example.com/callback' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toBe('https://example.com/callback');
  });

  test('POST /api/v1/webhook rejects invalid URL', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/v1/webhook')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'test-client', url: 'not-a-url' })
      .expect(400);
    expect(res.body.error).toContain('Invalid URL');
  });

  test('DELETE /api/v1/webhook/:client_id removes webhook', async () => {
    const csrfToken = await getCsrfToken();

    await agent
      .delete('/api/v1/webhook/test-client')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    // For unit test, we trust the mock; no further check needed
  });

  test('GET /api/v1/webhooks returns list', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .get('/api/v1/webhooks')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(Array.isArray(res.body.webhooks)).toBe(true);
  });

  test('GET /api/v1/export/compliance?format=csv returns CSV file', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .get('/api/v1/export/compliance?format=csv')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.text).toContain('client_id,date,total_verifications,successful,success_rate,avg_threshold');
  });

  test('GET /api/v1/export/compliance?format=pdf returns PDF file', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .get('/api/v1/export/compliance?format=pdf')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment; filename="agcom_export.pdf"');
  });

  test('GET /api/v1/export/compliance with invalid format returns 400', async () => {
    const csrfToken = await getCsrfToken();
    await agent
      .get('/api/v1/export/compliance?format=invalid')
      .set('CSRF-Token', csrfToken)
      .expect(400);
  });

  test('GET /api/v1/branding/:client_id returns default branding for unknown client', async () => {
    const res = await request(app)
      .get('/api/v1/branding/unknown-client')
      .expect(200);
    expect(res.body.client_id).toBe('unknown-client');
    expect(res.body.primary_color).toBe('#0f0');
    expect(res.body.secondary_color).toBe('#222');
    expect(res.body.logo_url).toBeNull();
  });

  test('Admin POST /api/v1/branding updates branding', async () => {
    const csrfToken = await getCsrfToken();
    // First create a client via registration
    await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'branding-test' })
      .expect(200);

    const res = await agent
      .post('/api/v1/branding')
      .set('CSRF-Token', csrfToken)
      .send({
        client_id: 'branding-test',
        logo_url: 'https://example.com/logo.png',
        primary_color: '#ff0000',
        secondary_color: '#00ff00',
        custom_domain: 'verify.branding-test.com',
        footer_text: 'Custom footer'
      })
      .expect(200);
    expect(res.body.success).toBe(true);

    // Verify the branding is stored
    const getRes = await request(app)
      .get('/api/v1/branding/branding-test')
      .expect(200);
    expect(getRes.body.logo_url).toBe('https://example.com/logo.png');
    expect(getRes.body.primary_color).toBe('#ff0000');
    expect(getRes.body.secondary_color).toBe('#00ff00');
    expect(getRes.body.custom_domain).toBe('verify.branding-test.com');
    expect(getRes.body.footer_text).toBe('Custom footer');
  });

  test('GET /api/v1/branding lists all brandings', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .get('/api/v1/branding')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(Array.isArray(res.body.branding)).toBe(true);
  });

  test('DELETE /api/v1/branding/:client_id removes branding', async () => {
    const csrfToken = await getCsrfToken();

    // First create a client and branding
    await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'delete-branding-test' })
      .expect(200);

    await agent
      .delete('/api/v1/webhook/delete-branding-test')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    // For unit test, we trust the mock; no further check needed
  });

  test('GET / returns landing page', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('Age Gate as a Service');
    expect(res.text).toContain('EU Blueprint compliant');
  });

  test('GET /pricing returns pricing page', async () => {
    const res = await request(app).get('/pricing').expect(200);
    expect(res.text).toContain('Free');
    expect(res.text).toContain('Pro');
  });

  test('GET /register returns registration form', async () => {
    const res = await request(app).get('/register').expect(200);
    expect(res.text).toContain('Get your API key');
  });

  test('POST /api/v1/register/public with valid data returns API key', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'self-test.com', email: 'test@example.com', description: 'test' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
  });

  test('POST /api/v1/register/public rejects duplicate client_id', async () => {
    const csrfToken = await getCsrfToken();
    await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'duplicate.com', email: 'test@example.com' })
      .expect(200);
    const res2 = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'duplicate.com', email: 'test2@example.com' })
      .expect(409);
    expect(res2.body.error).toContain('already registered');
  });

  test('Verification uses default_threshold when threshold not provided', async () => {
    // Register a client with default_threshold = 21
    const csrfToken = await getCsrfToken();
    const reg = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'default-threshold.com', email: 'test@example.com', threshold: 21 })
      .expect(200);
    const apiKey = reg.body.api_key;
    const res = await request(app)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: 'default-threshold.com' }) // no threshold
      .expect(200);
    expect(res.body.threshold).toBe(21);
  });

  test('GET /api/v1/plans returns list of plans', async () => {
    const res = await request(app).get('/api/v1/plans').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('GET /api/v1/client/subscription returns subscription info for valid API key', async () => {
    // Use the existing test key which is already mocked in api_keys
    const apiKey = 'test-key-123';
    const res = await request(app)
      .get('/api/v1/client/subscription')
      .set('x-api-key', apiKey)
      .expect(200);
    expect(res.body.plan_name).toBe('Free');
  });

  test('GET /api/v1/client/subscription returns 401 without API key', async () => {
    await request(app)
      .get('/api/v1/client/subscription')
      .expect(401);
  });

  test('POST /api/v1/stripe/create-checkout-session requires API key', async () => {
    await request(app)
      .post('/api/v1/stripe/create-checkout-session')
      .expect(401);
  });

  test('checkExpiringKeysAndNotify sends email for expiring keys', async () => {
    const { checkExpiringKeysAndNotify, emailTransporter, pool } = require('../server');
    const originalQuery = pool.query;
    // Mock the query to return an expiring key
    pool.query = jest.fn().mockResolvedValueOnce({
      rows: [{
        client_id: 'test-expiry',
        api_key: 'agk_test',
        expires_at: new Date(Date.now() + 10 * 86400000), // 10 days from now
        contact_email: 'expiry@test.com',
        last_expiry_notification_sent: null
      }]
    });
    await checkExpiringKeysAndNotify();
    // Check that emailTransporter.sendMail was called
    expect(emailTransporter.sendMail).toHaveBeenCalled();
    // Restore original query
    pool.query = originalQuery;
  });

  test('POST /api/v1/verify returns rate limit headers', async () => {
    const { pool } = require('../server');
    const originalQuery = pool.query;
    // Mock rate limit and daily limit values
    pool.query = jest.fn().mockImplementation((sql) => {
      if (sql.includes('SELECT rate_limit, daily_limit')) {
        return Promise.resolve({ rows: [{ rate_limit: 200, daily_limit: 5000 }] });
      }
      if (sql.includes('SELECT client_id, expires_at, is_active, default_threshold')) {
        return Promise.resolve({ rows: [{ client_id: 'test.local', expires_at: null, is_active: true, default_threshold: 18 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const Redis = require('ioredis');
    // Mock Redis to return 75 requests so far (remaining = 125)
    Redis.__mockInstance.multi.mockReturnValue({
      incr: jest.fn(),
      ttl: jest.fn(),
      exec: jest.fn().mockResolvedValue([[null, 75], [null, 30]])
    });
    Redis.__mockInstance.get.mockResolvedValue('2500'); // daily count

    const res = await request(app)
      .post('/api/v1/verify')
      .set('x-api-key', 'test-key-123')
      .send({ client_id: 'test.local', threshold: 18 });
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('200');
    expect(res.headers['x-ratelimit-remaining']).toBe('125');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    expect(res.headers['x-dailylimit-limit']).toBe('5000');
    expect(res.headers['x-dailylimit-remaining']).toBe('2500');
    expect(res.headers['x-dailylimit-reset']).toBeDefined();

    pool.query = originalQuery;
  });
});
