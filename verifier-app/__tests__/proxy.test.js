const { hashIP, verifyIP, anonymizeIPMiddleware } = require('../proxy');

describe('Proxy IP Anonymization', () => {
  beforeEach(() => {
    process.env.IP_SALT = 'test-salt-2026-04-08';
  });

  test('hashIP should return deterministic SHA256 hash', async () => {
    const ip = '192.168.1.1';
    const hash1 = await hashIP(ip);
    const hash2 = await hashIP(ip);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('hashIP with different IPs produces different hashes', async () => {
    const hash1 = await hashIP('192.168.1.1');
    const hash2 = await hashIP('192.168.1.2');

    expect(hash1).not.toBe(hash2);
  });

  test('hashIP with different salt produces different hash', async () => {
    const hash1 = await hashIP('192.168.1.1', 'salt1');
    const hash2 = await hashIP('192.168.1.1', 'salt2');

    expect(hash1).not.toBe(hash2);
  });

  test('verifyIP should correctly validate a known IP/hash pair', async () => {
    const ip = '10.0.0.1';
    const hash = await hashIP(ip);

    expect(await verifyIP(ip, hash)).toBe(true);
    expect(await verifyIP('10.0.0.2', hash)).toBe(false);
  });

  test('middleware should add anonymizedIP to request', async () => {
    const req = {
      ip: '127.0.0.1',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = {};
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = anonymizeIPMiddleware({ enabled: true });
    await middleware(req, res, next);

    expect(nextCalled).toBe(true);
    expect(req.anonymizedIP).toBeDefined();
    expect(req.anonymizedIP).toHaveLength(64);
    expect(req.headers['x-anonymized-ip']).toBe(req.anonymizedIP);
  });

  test('middleware in disabled mode should pass real IP', async () => {
    const req = {
      ip: '192.168.1.100',
      headers: {}
    };
    const res = {};
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = anonymizeIPMiddleware({ enabled: false });
    await middleware(req, res, next);

    expect(nextCalled).toBe(true);
    expect(req.anonymizedIP).toBe(req.ip);
  });
});
