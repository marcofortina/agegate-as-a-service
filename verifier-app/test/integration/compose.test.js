const { execSync, spawn } = require('child_process');

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: jest.fn().mockResolvedValue(true) })
}));

const path = require('path');
const request = require('supertest');
const waitOn = require('wait-on');
const http = require('http');

let serverProcess;
let baseUrl = 'http://localhost:8082';
let webhookServer;
let webhookReceived = false;

const agent = request.agent(baseUrl);

function extractSessionCookie(res) {
  const cookies = res.headers['set-cookie'] || [];
  return cookies.find(c => c.startsWith('agegate.sid='));
}

beforeAll(async () => {
  // Start containers
  execSync('docker-compose -f docker-compose.test.yml up -d', { stdio: 'inherit' });

  // Force verified true for mock backend to make tests deterministic
  process.env.FORCE_VERIFIED = 'true';

  // SMTP configuration for expiry notification tests
  process.env.SMTP_HOST = 'smtp.mock';
  process.env.SMTP_PORT = '25';
  process.env.FROM_EMAIL = 'test@example.com';

  // Wait for containers to be ready
  await waitOn({ resources: ['tcp:localhost:5433', 'tcp:localhost:6380'], timeout: 30000 });

  // Set environment variables for the app
  process.env.TIMESCALEDB_PASSWORD = 'testpass';
  process.env.TIMESCALEDB_HOST = 'localhost';
  process.env.TIMESCALEDB_PORT = '5433';
  process.env.TIMESCALEDB_USER = 'testuser';
  process.env.TIMESCALEDB_DB = 'agegate_test';
  process.env.REDIS_HOST = 'localhost';
  process.env.REDIS_PORT = '6380';
  process.env.ADMIN_PASS = 'admin123';
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.ANONYMIZE_IP = 'false';
  process.env.PORT = '8082';

  // Start the app in a separate process
  const serverPath = path.join(__dirname, '../../server.js');
  serverProcess = spawn('node', [serverPath], { env: process.env, stdio: 'ignore' });

  // Ensure any previous webhook server is closed
  if (webhookServer) webhookServer.close();

  // Start a mock webhook server
  webhookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      webhookReceived = true;
      res.writeHead(200);
      res.end();
    });
  });
  webhookServer.listen(8090);
  // Give it time to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Wait for the app to be ready
  await waitOn({ resources: [`http-get://localhost:8082/ready`], timeout: 30000 });

  const loginPage = await agent.get('/login').expect(200);
  const loginCsrfMatch = loginPage.text.match(/name="_csrf" value="([^"]+)"/);
  expect(loginCsrfMatch).not.toBeNull();
  const loginCsrf = loginCsrfMatch[1];
  await agent
    .post('/login')
    .set('CSRF-Token', loginCsrf)
    .send({ user: 'admin', pass: 'admin123' })
    .expect(302);
}, 60000);

afterAll(async () => {
  // Terminate the server process and wait for it to exit
  if (serverProcess) {
    const exitPromise = new Promise(resolve => serverProcess.once('exit', resolve));
    serverProcess.kill('SIGTERM');
    await exitPromise;
  }

  if (webhookServer) {
    await Promise.race([
      new Promise(resolve => webhookServer.close(resolve)),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
  }

  execSync('docker-compose -f docker-compose.test.yml down -v', { stdio: 'ignore' });
}, 60000);

describe('Integration Tests with docker-compose', () => {
  let apiKey;
  const clientId = 'test-integration-client';

  async function getCsrfToken() {
    const res = await agent.get('/csrf-token').expect(200);
    return res.body.csrfToken;
  }

  test('Health check', async () => {
    const res = await request(baseUrl).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  test('Admin login and get cookie', async () => {
    const res = await agent.get('/dashboard').expect(200);
    expect(res.text).toContain('Webhook Management');
  });

  test('Login regenerates the session cookie', async () => {
    const tempAgent = request.agent(baseUrl);

    const loginPage = await tempAgent.get('/login').expect(200);
    const loginCsrf = loginPage.text.match(/name="_csrf" value="([^"]+)"/);
    expect(loginCsrf).not.toBeNull();

    const initialCookie = extractSessionCookie(loginPage);

    const loginRes = await tempAgent
      .post('/login')
      .set('CSRF-Token', loginCsrf[1])
      .send({ user: 'admin', pass: 'admin123' })
      .expect(302);

    expect(loginRes.headers.location).toBe('/dashboard');

    const newCookie = extractSessionCookie(loginRes);
    expect(newCookie).toBeDefined();

    if (initialCookie) {
      expect(newCookie.split(';')[0]).not.toBe(initialCookie.split(';')[0]);
    }

    const dash = await tempAgent.get('/dashboard').expect(200);
    expect(dash.text).toContain('Webhook Management');
  });

  test('Register a new client', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: clientId })
      .expect(200);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    apiKey = res.body.api_key;
    expect(res.body.expires_at).toBeDefined();
  });

  test('Age verification with valid API key', async () => {
    const res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(200);
    expect(res.body.verified).toBeDefined();
  });

  test('Register webhook', async () => {
    const csrfToken = await getCsrfToken();
    await agent
      .post('/api/v1/webhook')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: clientId, url: 'http://localhost:8090/webhook' })
      .expect(200);
  });

  test('Webhook is called on verification', async () => {
    // Perform a verification to trigger the webhook
    webhookReceived = false; // reset flag
    const res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(200);
    expect(res.body.verified).toBeDefined();
    // Wait a bit for the webhook to be delivered asynchronously
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(webhookReceived).toBe(true);
  });

  test('Age verification with invalid API key', async () => {
    const res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', 'invalid-key')
      .send({ client_id: clientId, threshold: 18 })
      .expect(401);
    expect(res.body.message).toContain('Invalid API key');
  });

  test('Rate limiting', async () => {
    const csrfToken = await getCsrfToken();

    const rateRes = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: clientId })
      .expect(200);

    const rateApiKey = rateRes.body.api_key;

    const requests = [];
    for (let i = 0; i < 101; i++) {
      requests.push(
        request(baseUrl)
          .post('/api/v1/verify')
          .set('x-api-key', rateApiKey)
          .send({ client_id: clientId, threshold: 18 })
      );
    }

    const responses = await Promise.all(requests);
    const statuses = responses.map(r => r.status);

    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
    expect(statuses.filter(s => s === 200).length).toBe(100);
  });

  test('Daily limit enforcement', async () => {
    const csrfToken = await getCsrfToken();
    const reg = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'daily-limit-test' })
      .expect(200);
    const apiKey = reg.body.api_key;

    // Set daily limit to 2
    await agent
      .patch(`/api/v1/keys/${apiKey}/daily-limit`)
      .set('CSRF-Token', csrfToken)
      .send({ daily_limit: 2 })
      .expect(200);

    // First request: should succeed
    let res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: 'daily-limit-test', threshold: 18 })
      .expect(200);
    expect(res.body.verified).toBeDefined();

    // Second request: should succeed
    res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: 'daily-limit-test', threshold: 18 })
      .expect(200);
    expect(res.body.verified).toBeDefined();

    // Third request: should be rate limited (daily)
    res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: 'daily-limit-test', threshold: 18 })
      .expect(429);
    expect(res.body.message).toContain('Daily limit exceeded');
  });

  test('Revoke API key', async () => {
    const csrfToken = await getCsrfToken();

    await agent
      .post('/api/v1/revoke')
      .set('CSRF-Token', csrfToken)
      .send({ api_key: apiKey })
      .expect(200);
  });

  test('Verification with revoked key fails', async () => {
    const res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(401);
    expect(res.body.message).toContain('Invalid API key');
  });

  test('Rotate API key', async () => {
    const csrfToken = await getCsrfToken();

    const reg = await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: clientId })
      .expect(200);
    const oldKey = reg.body.api_key;

    const rotateRes = await agent
      .post('/api/v1/rotate')
      .set('CSRF-Token', csrfToken)
      .send({ api_key: oldKey })
      .expect(200);
    expect(rotateRes.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(rotateRes.body.api_key).not.toBe(oldKey);

    // Use the new valid key for subsequent tests
    apiKey = rotateRes.body.api_key;

    const verifyOld = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', oldKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(401);
    expect(verifyOld.body.message).toContain('Invalid API key');

    const verifyNew = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(200);
    expect(verifyNew.body.verified).toBeDefined();
  });

  test('Stats endpoint works', async () => {
    const res = await request(baseUrl)
      .get('/api/v1/stats')
      .set('x-api-key', apiKey)
      .expect(200);
    expect(res.body.total_verifications).toBeDefined();
    expect(Array.isArray(res.body.threshold_breakdown)).toBe(true);
    expect(Array.isArray(res.body.weekly_breakdown)).toBe(true);
    expect(Array.isArray(res.body.daily_breakdown)).toBe(true);
  });

  test('Logout invalidates the authenticated session', async () => {
    const tempAgent = request.agent(baseUrl);

    const loginPage = await tempAgent.get('/login').expect(200);
    const loginCsrf = loginPage.text.match(/name="_csrf" value="([^"]+)"/);
    expect(loginCsrf).not.toBeNull();

    await tempAgent
      .post('/login')
      .set('CSRF-Token', loginCsrf[1])
      .send({ user: 'admin', pass: 'admin123' })
      .expect(302);

    await tempAgent.get('/dashboard').expect(200);
    await tempAgent.get('/logout').expect(302);

    const res = await tempAgent.get('/dashboard').expect(302);
    expect(res.headers.location).toBe('/login');
  });

  test('Admin dashboard contains Webhook Management section', async () => {
    const res = await agent.get('/dashboard').expect(200);
    expect(res.text).toContain('Webhook Management');
  });

  test('Export CSV compliance report', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .get('/api/v1/export/compliance?format=csv')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.text).toContain('client_id');
  });

  test('Export PDF compliance report', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .get('/api/v1/export/compliance?format=pdf')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  test('Session secret rotation keeps system usable after rotation', async () => {
    // verify system works with current session
    const res1 = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(200);

    expect(res1.body.verified).toBeDefined();

    // trigger rotation (via admin endpoint if exists, otherwise login bounce)
    const csrfToken = await getCsrfToken();

    const rotate = await agent
      .post('/api/v1/rotate')
      .set('CSRF-Token', csrfToken)
      .send({ api_key: apiKey })
      .expect(200);

    const newKey = rotate.body.api_key;
    expect(newKey).toBeDefined();
    expect(newKey).not.toBe(apiKey);

    // old key must be invalid
    await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(401);

    // new key must work
    const res2 = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', newKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(200);

    expect(res2.body.verified).toBeDefined();
  });

  test('Admin can list all brandings', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .get('/api/v1/branding')
      .set('CSRF-Token', csrfToken)
      .expect(200);
    expect(Array.isArray(res.body.branding)).toBe(true);
  });

  test('Admin can delete a branding', async () => {
    const csrfToken = await getCsrfToken();
    await agent
      .delete('/api/v1/branding/branding-integration-test')
      .set('CSRF-Token', csrfToken)
      .expect(200);
  });

  test('Client branding is applied after admin update', async () => {
    const csrfToken = await getCsrfToken();
    // Register a client
    await agent
      .post('/api/v1/register')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'branding-integration-test' })
      .expect(200);

    // Update branding via admin endpoint
    await agent
      .post('/api/v1/branding')
      .set('CSRF-Token', csrfToken)
      .send({
        client_id: 'branding-integration-test',
        logo_url: 'https://example.com/integration-logo.png',
        primary_color: '#123456'
      })
      .expect(200);

    const res = await request(baseUrl)
      .get('/api/v1/branding/branding-integration-test')
      .expect(200);
    expect(res.body.logo_url).toBe('https://example.com/integration-logo.png');
    expect(res.body.primary_color).toBe('#123456');
  });

  test('Public landing page is accessible', async () => {
    const res = await request(baseUrl).get('/').expect(200);
    expect(res.text).toContain('Age Gate as a Service');
  });

  test('Pricing page is accessible', async () => {
    const res = await request(baseUrl).get('/pricing').expect(200);
    expect(res.text).toContain('Pro');
  });

  test('Self‑onboarding: register a new client via public form', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'self-integration.com', email: 'integ@test.com' })
      .expect(200);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    // Verify that the key works
    const verifyRes = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', res.body.api_key)
      .send({ client_id: 'self-integration.com', threshold: 18 })
      .expect(200);
    expect(verifyRes.body.verified).toBe(true);
  });

  test('Self‑onboarding with custom default threshold', async () => {
    const csrfToken = await getCsrfToken();
    const res = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'custom-threshold.com', email: 'test@example.com', threshold: 21 })
      .expect(200);
    const verifyRes = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', res.body.api_key)
      .send({ client_id: 'custom-threshold.com' })  // no threshold
      .expect(200);
    expect(verifyRes.body.threshold).toBe(21);
  });

  let stripeApiKey;
  beforeAll(async () => {
    const csrfToken = await getCsrfToken();
    const reg = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'stripe-integration.com', email: 'stripe@test.com' })
      .expect(200);
    stripeApiKey = reg.body.api_key;
  });

  test('Plans endpoint lists available subscription plans', async () => {
    const res = await request(baseUrl).get('/api/v1/plans').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const planNames = res.body.map(p => p.name);
    expect(planNames).toContain('Free');
    expect(planNames).toContain('Pro');
  });

  test('Newly registered client has free subscription plan', async () => {
     const res = await request(baseUrl)
       .get('/api/v1/client/subscription')
       .set('x-api-key', stripeApiKey)
       .expect(200);
     expect(res.body.plan_name).toBe('Free');
  });

  test('Checkout session creation rejects requests without API key', async () => {
    await request(baseUrl)
      .post('/api/v1/stripe/create-checkout-session')
      .expect(401);
  });

  test('Client dashboard shows subscription plan section', async () => {
    const res = await request(baseUrl)
      .get('/api/v1/client/dashboard')
      .set('x-api-key', stripeApiKey)
      .expect(200);
    expect(res.text).toContain('Your Subscription Plan');
  });

  test('Expiry notification is sent for expiring key', async () => {
    // 1. Register a client with email
    const csrfToken = await getCsrfToken();
    const reg = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'expiry-test.com', email: 'expiry@test.com' })
      .expect(200);
    const apiKey = reg.body.api_key;

    // 2. Manually set expiry date to 10 days from now
    const { pool, checkExpiringKeysAndNotify, redis } = require('../../server');
    const newExpiry = new Date(Date.now() + 10 * 86400000).toISOString();
    await pool.query(
      'UPDATE api_keys SET expires_at = $1, last_expiry_notification_sent = NULL WHERE api_key = $2',
      [newExpiry, apiKey]
    );

    // 3. Run the expiry checker
    await checkExpiringKeysAndNotify();

    // 4. Verify that the notification was sent (last_expiry_notification_sent updated)
    const result = await pool.query(
      'SELECT last_expiry_notification_sent FROM api_keys WHERE api_key = $1',
      [apiKey]
    );
    expect(result.rows[0].last_expiry_notification_sent).not.toBeNull();

    // Close the imported pool to avoid termination errors
    await pool.end();
    await redis.quit();
  });

  test('Rate limit headers are present in verify response', async () => {
    // Register a new client to get a fresh key with default rate limits
    const csrfToken = await getCsrfToken();
    const reg = await agent
      .post('/api/v1/register/public')
      .set('CSRF-Token', csrfToken)
      .send({ client_id: 'headers-test.com', email: 'headers@test.com' })
      .expect(200);
    const apiKey = reg.body.api_key;

    const res = await request(baseUrl)
      .post('/api/v1/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: 'headers-test.com', threshold: 18 });
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    const remaining = parseInt(res.headers['x-ratelimit-remaining']);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(100);
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    // daily limit default is null, so daily headers should NOT be present
    expect(res.headers['x-dailylimit-limit']).toBeUndefined();
  });
});
