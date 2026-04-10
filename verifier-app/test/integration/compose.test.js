const { execSync, spawn } = require('child_process');
const path = require('path');
const request = require('supertest');
const waitOn = require('wait-on');
const http = require('http');

let serverProcess;
let baseUrl = 'http://localhost:8082';
let webhookServer;
let webhookReceived = false;

const agent = request.agent(baseUrl);

beforeAll(async () => {
  // Start containers
  execSync('docker-compose -f docker-compose.test.yml up -d', { stdio: 'inherit' });

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
      console.log('Webhook received:', body);
      res.writeHead(200);
      res.end();
    });
  });
  webhookServer.listen(8090);
  // Give it time to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Wait for the app to be ready
  await waitOn({ resources: [`http-get://localhost:8082/ready`], timeout: 30000 });

  // Register webhook for the test client (will be done inside a test)
}, 60000);

afterAll(() => {
  if (serverProcess) serverProcess.kill('SIGTERM');
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
    await request(baseUrl)
      .get('/dashboard')
      .query({ auth: Buffer.from('admin:admin123').toString('base64') })
      .expect(302);
  });

  test('Register a new client', async () => {
    const csrfToken = await getCsrfToken();

    const res = await agent
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .auth('admin', 'admin123')
      .send({ client_id: clientId })
      .expect(200);
    expect(res.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    apiKey = res.body.api_key;
    expect(res.body.expires_at).toBeDefined();
  });

  test('Age verification with valid API key', async () => {
    const res = await request(baseUrl)
      .post('/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(200);
    expect(res.body.verified).toBeDefined();
  });

  test('Register webhook', async () => {
    const csrfToken = await getCsrfToken();
    console.log('Registering webhook for client', clientId);
    await agent
      .post('/api/webhook')
      .set('CSRF-Token', csrfToken)
      .auth('admin', 'admin123')
      .send({ client_id: clientId, url: 'http://localhost:8090/webhook' })
      .expect(200);
  });

  test('Webhook is called on verification', async () => {
    // Perform a verification to trigger the webhook
    webhookReceived = false; // reset flag
    console.log('Triggering verification for client', clientId);
    const res = await request(baseUrl)
      .post('/verify')
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
      .post('/verify')
      .set('x-api-key', 'invalid-key')
      .send({ client_id: clientId, threshold: 18 })
      .expect(401);
    expect(res.body.message).toContain('Invalid API key');
  });

  test('Rate limiting', async () => {
    const csrfToken = await getCsrfToken();

    const rateRes = await agent
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .auth('admin', 'admin123')
      .send({ client_id: clientId })
      .expect(200);

    const rateApiKey = rateRes.body.api_key;

    const requests = [];
    for (let i = 0; i < 101; i++) {
      requests.push(
        request(baseUrl)
          .post('/verify')
          .set('x-api-key', rateApiKey)
          .send({ client_id: clientId, threshold: 18 })
      );
    }

    const responses = await Promise.all(requests);
    const statuses = responses.map(r => r.status);

    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
    expect(statuses.filter(s => s === 200).length).toBe(100);
  });

  test('Revoke API key', async () => {
    const csrfToken = await getCsrfToken();

    await agent
      .post('/api/revoke')
      .set('CSRF-Token', csrfToken)
      .auth('admin', 'admin123')
      .send({ api_key: apiKey })
      .expect(200);
  });

  test('Verification with revoked key fails', async () => {
    const res = await request(baseUrl)
      .post('/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(401);
    expect(res.body.message).toContain('Invalid API key');
  });

  test('Rotate API key', async () => {
    const csrfToken = await getCsrfToken();

    const reg = await agent
      .post('/api/register')
      .set('CSRF-Token', csrfToken)
      .auth('admin', 'admin123')
      .send({ client_id: clientId })
      .expect(200);
    const oldKey = reg.body.api_key;

    const rotateRes = await agent
      .post('/api/rotate')
      .set('CSRF-Token', csrfToken)
      .auth('admin', 'admin123')
      .send({ api_key: oldKey })
      .expect(200);
    expect(rotateRes.body.api_key).toMatch(/^agk_[a-f0-9]{48}$/);
    expect(rotateRes.body.api_key).not.toBe(oldKey);

    // Use the new valid key for subsequent tests
    apiKey = rotateRes.body.api_key;

    const verifyOld = await request(baseUrl)
      .post('/verify')
      .set('x-api-key', oldKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(401);
    expect(verifyOld.body.message).toContain('Invalid API key');

    const verifyNew = await request(baseUrl)
      .post('/verify')
      .set('x-api-key', apiKey)
      .send({ client_id: clientId, threshold: 18 })
      .expect(200);
    expect(verifyNew.body.verified).toBeDefined();
  });

  test('Stats endpoint works', async () => {
    const res = await request(baseUrl)
      .get('/stats')
      .set('x-api-key', apiKey)
      .expect(200);
    expect(res.body.total_verifications).toBeDefined();
  });

  test('Admin dashboard contains Webhook Management section', async () => {
    const res = await request(baseUrl)
      .get('/dashboard')
      .auth('admin', 'admin123')
      .expect(200);
    expect(res.text).toContain('Webhook Management');
  });
});
