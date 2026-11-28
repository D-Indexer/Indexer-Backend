import request from 'supertest';
import { createApp } from '../app';
import { loadEnv, TESTNET_CONTRACT_ID } from '../config/env';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/folder_test',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  FOLDER_CONTRACT_ID: TESTNET_CONTRACT_ID,
  IPFS_API_URL: 'http://localhost:5001',
  IPFS_GATEWAY: 'https://ipfs.io/ipfs',
};

/** Echoes req.ip so the trust proxy setting can be asserted end to end. */
function ipApp(trustProxy?: string) {
  const app = createApp(loadEnv({ ...baseEnv, TRUST_PROXY: trustProxy }));
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe('trust proxy', () => {
  it('uses the left-most untrusted address with TRUST_PROXY=1', async () => {
    const res = await request(ipApp('1'))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7, 10.0.0.1');

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('ignores spoofed X-Forwarded-For with TRUST_PROXY=false', async () => {
    const res = await request(ipApp('false'))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7');

    expect(res.status).toBe(200);
    expect(res.body.ip).not.toBe('203.0.113.7');
    expect(res.body.ip).toMatch(/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/);
  });

  it('trusts only listed CIDRs', async () => {
    const app = ipApp('10.0.0.0/8');
    const res = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7');

    // Loopback is not in 10.0.0.0/8, so the header is ignored.
    expect(res.body.ip).not.toBe('203.0.113.7');
  });

  it('exposes the trust proxy setting on the app', () => {
    expect(ipApp('2').get('trust proxy')).toBe(2);
    expect(ipApp().get('trust proxy')).toBe(false);
  });
});
