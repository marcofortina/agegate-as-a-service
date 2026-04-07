const request = require('supertest');
const express = require('express');
const app = require('../server'); // import app

jest.mock('pg');
jest.mock('ioredis');
jest.mock('prom-client');

describe('AgeGate as a Service - API Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /health should return healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
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
    const res = await request(app)
      .post('/verify')
      .set('x-api-key', 'rate-limit-key')
      .send({ client_id: 'test.local', threshold: 18 });

    expect(res.status).toBe(429);
  });

  test('POST /verify - Zod validation error', async () => {
    const res = await request(app)
      .post('/verify')
      .set('x-api-key', 'test-key')
      .send({ threshold: 99 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid input');
  });

  test('GET /api-docs should serve Swagger UI', async () => {
    const res = await request(app).get('/api-docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger');
  });
});
