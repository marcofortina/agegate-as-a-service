try {
  require('dotenv').config({ override: false });
} catch { /* dotenv not available, using env vars */ }

// Disable IP anonymization during tests (avoids Redis dependency)
process.env.ANONYMIZE_IP = 'false';

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
        if (sql.includes('WHERE created_by')) {
          return Promise.resolve({ rows: [{ count: 0 }] });
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
});
