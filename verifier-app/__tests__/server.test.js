try {
  require('dotenv').config({ override: false });
} catch { /* dotenv not available, using env vars */ }

// Disable IP anonymization during tests (avoids Redis dependency)
process.env.ANONYMIZE_IP = 'false';
// Use ADMIN_PASS from environment
const ADMIN_PASS = process.env.ADMIN_PASS;

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
const { app, server } = require('../server');

describe('AgeGate as a Service - API Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    server.close();
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
    expect(res.text).toContain('<input id="user"');
    expect(res.text).toContain('<input id="pass" type="password"');
  });

  test('GET /dashboard without auth redirects to /login', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /dashboard with wrong auth still redirects', async () => {
    const wrongAuth = Buffer.from('admin:wrongpassword').toString('base64');
    const res = await request(app)
      .get('/dashboard')
      .set('Authorization', `Basic ${wrongAuth}`);
    expect(res.status).toBe(302);
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
    const res = await request(app)
      .get('/api/keys/test.local')
      .auth('admin', ADMIN_PASS)
      .expect(200);

    expect(res.body.client_id).toBe('test.local');
    expect(Array.isArray(res.body.keys)).toBe(true);
  });

  test('POST /api/register with description', async () => {
    const res = await request(app)
      .post('/api/register')
      .auth('admin', ADMIN_PASS)
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

    const res = await request(app)
      .post('/api/register')
      .auth('admin', ADMIN_PASS)
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
    const reg = await request(app)
      .post('/api/register')
      .auth('admin', ADMIN_PASS)
      .send({ client_id: 'rotate-test' })
      .expect(200);
    registeredKey = reg.body.api_key;

    // Rotate
    const res = await request(app)
      .post('/api/rotate')
      .auth('admin', ADMIN_PASS)
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
    const reg = await request(app)
      .post('/api/register')
      .auth('admin', ADMIN_PASS)
      .send({ client_id: 'rate-test' })
      .expect(200);
    const apiKey = reg.body.api_key;

    const res = await request(app)
      .patch(`/api/keys/${apiKey}/rate-limit`)
      .auth('admin', ADMIN_PASS)
      .send({ rate_limit: 200 })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.rate_limit).toBe(200);

    // Optionally verify that rate limit is enforced (requires mocking redis)
    // For unit test, we trust the database update.
  });

  // Additional test: invalid rate_limit
  test('PATCH /api/keys/:api_key/rate-limit rejects invalid values', async () => {
    const res = await request(app)
      .patch('/api/keys/some-key/rate-limit')
      .auth('admin', ADMIN_PASS)
      .send({ rate_limit: 0 })
      .expect(400);
    expect(res.body.error).toContain('between 1 and 10000');
  });
});
