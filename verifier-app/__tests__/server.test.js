try {
  require('dotenv').config({ override: false });
} catch { /* dotenv not available, using env vars */ }

// Disable IP anonymization during tests (avoids Redis dependency)
process.env.ANONYMIZE_IP = 'false';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

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
    expire: jest.fn(),
    decr: jest.fn(),
    del: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn()
  };

  const RedisMock = jest.fn(() => mockRedis);
  RedisMock.__mockInstance = mockRedis;

  return RedisMock;
});

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: jest.fn().mockImplementation((sql, params) => {
        // Handle api_keys table queries
        if (sql.includes('FROM api_keys')) {
          const key = params ? params[0] : null;

          if (sql.includes('SELECT description FROM api_keys WHERE api_key = $1')) {
            return Promise.resolve({ rows: [{ description: 'Test description' }] });
          }

          if (sql.includes('UPDATE api_keys SET description = $1 WHERE api_key = $2')) {
            return Promise.resolve({ rows: [] });
          }

          if (sql.includes('SELECT client_id, is_active, expires_at FROM api_keys WHERE api_key = $1')) {
            return Promise.resolve({
              rows: [{ client_id: 'test.local', is_active: true, expires_at: null }]
            });
          }

          if (sql.includes('UPDATE api_keys SET is_active = false WHERE api_key = $1')) {
            return Promise.resolve({ rows: [] });
          }

          // Recognized test keys
          if (key === 'test-key-123' || key === 'rate-limit-key') {
            return Promise.resolve({ rows: [{ client_id: 'test.local', expires_at: null, is_active: true }] });
          }
          return Promise.resolve({ rows: [] });
        }
        // Handle INSERT into api_keys (for /api/register tests or migration)
        if (sql.includes('INSERT INTO api_keys')) {
          return Promise.resolve({ rows: [{ api_key: params[1] }] });
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
        // Handle SELECT rate_limit
        if (sql.includes('SELECT rate_limit FROM api_keys WHERE api_key = $1')) {
          return Promise.resolve({ rows: [{ rate_limit: 100 }] });
        }
        if (sql.includes('WHERE created_by')) {
          return Promise.resolve({ rows: [{ count: 0 }] });
        }
        // Handle query for /api/keys/:client_id
        if (sql.includes('SELECT api_key, created_at, expires_at, last_used_at, is_active, created_by, description FROM api_keys WHERE client_id = $1')) {
          return Promise.resolve({ rows: [{ api_key: 'test-key-123', created_at: new Date(), expires_at: null, last_used_at: null, is_active: true, created_by: 'admin', description: 'Test key' }] });
        }
        // Handle UPDATE rate_limit
        if (sql.includes('UPDATE api_keys SET rate_limit = $1 WHERE api_key = $2 RETURNING client_id')) {
          return Promise.resolve({ rows: [{ client_id: 'rate-test' }] });
        }
        // Handle UPDATE description
        if (sql.includes('UPDATE api_keys SET description = $1 WHERE api_key = $2 RETURNING client_id')) {
          if (params && params[1] === 'nonexistent') {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [{ client_id: 'desc-test' }] });
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

// Force deterministic behavior
jest.spyOn(Math, 'random').mockReturnValue(1);

// NOW require app AFTER mocks
const { app, getServer } = require('../server');

// Supertest agent to handle cookies for CSRF
const agent = request.agent(app);

beforeAll(async () => {
  await agent.get('/health').expect(200);

  const loginPage = await agent.get('/login').expect(200);
  const loginCsrf = loginPage.text.match(/name="_csrf" value="([^"]+)"/);
  expect(loginCsrf).not.toBeNull();

  await agent
    .post('/login')
    .set('CSRF-Token', loginCsrf[1])
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

  test('POST /verify - valid request with mock backend', async () => {
    const res = await request(app)
      .post('/verify')
      .set('x-api-key', 'test-key-123')
      .send({ client_id: 'test.local', threshold: 18 });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.ageOverThreshold).toBe(true);
    expect(res.body.proofType).toBeDefined();
  });

  test('POST /verify - rate limit exceeded', async () => {
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
      .post('/verify')
      .set('x-api-key', 'rate-limit-key')
      .send({ client_id: 'test.local', threshold: 18 });

    expect(res.status).toBe(429);
  });

  test('POST /verify - Zod validation error', async () => {
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
      .post('/verify')
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

  test('GET /stats with valid API key', async () => {
    const res = await request(app)
      .get('/stats')
      .set('x-api-key', 'test-key-123')
      .expect(200);

    expect(res.body.client_id).toBe('test.local');
    expect(res.body.total_verifications).toBe(42);
  });

  test('GET /api/keys/:client_id returns keys for admin', async () => {
    const res = await agent.get('/api/keys/test.local').expect(200);

    expect(res.body.client_id).toBe('test.local');
    expect(Array.isArray(res.body.keys)).toBe(true);
  });

  test('POST /api/register with description', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'desc-test', description: 'My test key' })
      .expect(200);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(res.body.expires_at).toBeDefined();
    // Check that description was passed (mock does not store, but we trust the code)
    // In real DB, description would be stored.
  });

  test('POST /api/register retries on key collision', async () => {
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
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'collision-test', description: 'retry test' })
      .expect(200);

    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(insertAttempts).toBe(2);

    pool.query = originalQuery;
  });

  test('POST /api/rotate retries on key collision', async () => {
    const { pool } = require('../server');
    const originalQuery = pool.query;

    let insertAttempts = 0;
    let registeredKey = null;
    const mockQuery = jest.fn(async (sql, params) => {
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
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'rotate-test' })
      .expect(200);
    registeredKey = reg.body.api_key;

    // Rotate
    const res = await agent
      .post('/api/rotate')
      .set('CSRF-Token', csrfToken)
      .send({ api_key: registeredKey })
      .expect(200);

    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(insertAttempts).toBe(2);

    // Verify old key is revoked
    const verifyOld = await request(app)
      .post('/verify')
      .set('x-api-key', registeredKey)
      .send({ client_id: 'rotate-test', threshold: 18 })
      .expect(401);
    expect(verifyOld.body.message).toContain('Invalid API key');

    pool.query = originalQuery;
  });

  test('PATCH /api/keys/:api_key/rate-limit updates rate limit', async () => {
    // Register a key
    const csrfToken = await getCsrfToken();

    const reg = await agent
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'rate-test' })
      .expect(200);
    const apiKey = reg.body.api_key;

    const res = await agent
      .patch(`/api/keys/${apiKey}/rate-limit`)
      .set('CSRF-Token', csrfToken)
      .send({ rate_limit: 200 })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.rate_limit).toBe(200);

    // Optionally verify that rate limit is enforced (requires mocking redis)
    // For unit test, we trust the database update.
  });

  // Additional test: invalid rate_limit
  test('PATCH /api/keys/:api_key/rate-limit rejects invalid values', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .patch('/api/keys/some-key/rate-limit')
      .set('CSRF-Token', csrfToken)
      .send({ rate_limit: 0 })
      .expect(400);
    expect(res.body.error).toContain('between 1 and 10000');
  });

  test('PATCH /api/keys/:api_key/description updates description', async () => {
    const csrfToken = await getCsrfToken();

    // Register a key
    const reg = await agent
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'desc-test' })
      .expect(200);
    const apiKey = reg.body.api_key;

    const res = await agent
      .patch(`/api/keys/${apiKey}/description`)
      .set('CSRF-Token', csrfToken)
      .send({ description: 'New description' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.description).toBe('New description');
  });

  test('PATCH /api/keys/:api_key/description rejects invalid input', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .patch('/api/keys/some-key/description')
      .set('CSRF-Token', csrfToken)
      .send({ description: 123 }) // not a string
      .expect(400);
    expect(res.body.error).toContain('must be a string');
  });

  test('PATCH /api/keys/:api_key/description returns 404 for nonexistent key', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .patch('/api/keys/nonexistent/description')
      .set('CSRF-Token', csrfToken)
      .send({ description: 'test' })
      .expect(404);
    expect(res.body.error).toContain('API key not found');
  });

  test('GET /client/description returns description', async () => {
    const res = await request(app)
      .get('/client/description')
      .set('x-api-key', 'test-key-123')
      .expect(200);
    expect(res.body.description).toBe('Test description');
  });

  test('PATCH /client/description updates description', async () => {
    const res = await request(app)
      .patch('/client/description')
      .set('x-api-key', 'test-key-123')
      .send({ description: 'New client description' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.description).toBe('New client description');
  });

  test('POST /client/rotate returns new API key', async () => {
    const res = await request(app)
      .post('/client/rotate')
      .set('x-api-key', 'test-key-123')
      .expect(200);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(res.body.client_id).toBe('test.local');
    // Revocation verification is omitted in unit test (covered by integration tests)
  });

  test('GET /client/dashboard returns HTML', async () => {
    const res = await request(app)
      .get('/client/dashboard')
      .set('x-api-key', 'test-key-123')
      .expect(200);
    expect(res.text).toContain('Age Gate Client Dashboard');
  });

  test('POST /api/webhook sets webhook URL', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/webhook')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'test-client', url: 'https://example.com/callback' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toBe('https://example.com/callback');
  });

  test('POST /api/webhook rejects invalid URL', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/webhook')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'test-client', url: 'not-a-url' })
      .expect(400);
    expect(res.body.error).toContain('Invalid URL');
  });

  test('DELETE /api/webhook/:client_id removes webhook', async () => {
    const csrfToken = await getCsrfToken();

    await agent
      .delete('/api/webhook/test-client')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    // For unit test, we trust the mock; no further check needed
  });

  test('GET /api/webhooks returns list', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .get('/api/webhooks')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(Array.isArray(res.body.webhooks)).toBe(true);
  });
});
