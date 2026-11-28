import { Router } from 'express';
import { run } from '../cli/keys';
import { createApiKeyAuth } from '../middleware/apiKey';
import { hashApiKey, UsageRecorder } from '../services/apiKeys';
import { serve } from './httpHarness';
import { createTestSchema, describeDb, type TestSchema } from './pgSchema';

const SECRET = 'db-test-secret-db-test-secret-0123456789';

describeDb('API keys against Postgres', () => {
  let schema: TestSchema;

  function cli(argv: string[], secret: string | undefined = SECRET) {
    const out: string[] = [];
    const err: string[] = [];
    return run(argv, schema.pool, secret, { out: (t) => out.push(t), err: (t) => err.push(t) }).then(
      (code) => ({ code, out: out.join('\n'), err: err.join('\n') })
    );
  }

  async function createKey(...extra: string[]): Promise<{ id: number; key: string }> {
    const res = await cli(['create', '--name', 'Explorer Inc', '--contact', 'ops@example.com', ...extra]);
    expect(res.code).toBe(0);
    const key = /(fk_[A-Za-z0-9_-]{43})/.exec(res.out)?.[1];
    const id = /Created API key (\d+)/.exec(res.out)?.[1];
    if (!key || !id) throw new Error(`unexpected output: ${res.out}`);
    return { id: Number(id), key };
  }

  beforeAll(async () => {
    schema = await createTestSchema('test_api_keys');
  });
  beforeEach(() => schema.reset());
  afterAll(() => schema.close());

  it('creates a key, shows it once, and stores only its HMAC', async () => {
    const { id, key } = await createKey('--quota', '1000');

    const { rows } = await schema.pool.query('SELECT * FROM api_keys WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({
      key_hash: hashApiKey(SECRET, key),
      name: 'Explorer Inc',
      contact: 'ops@example.com',
      revoked_at: null,
      monthly_quota: '1000',
    });
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain(key.slice(3)); // nor the random part
    expect((await cli(['list'])).out).not.toContain(key);
  });

  it('lists keys with this month usage and revokes them', async () => {
    const { id } = await createKey();
    const recorder = new UsageRecorder(schema.pool);
    const today = new Date().toISOString().slice(0, 10);
    recorder.record(id, today, 4);
    await recorder.flush();

    const listed = await cli(['list']);
    expect(listed.out).toMatch(
      new RegExp(`^${id}\\s+Explorer Inc\\s+ops@example.com\\s+\\S+\\s+-\\s+-\\s+4$`, 'm')
    );

    const revoked = await cli(['revoke', String(id)]);
    expect(revoked.code).toBe(0);
    expect(revoked.out).toContain(`Revoked API key ${id}`);
    const { rows } = await schema.pool.query('SELECT revoked_at FROM api_keys WHERE id = $1', [id]);
    expect(rows[0].revoked_at).toBeInstanceOf(Date);
  });

  it.each([
    [['create', '--name', 'x'], 'create needs --name and --contact'],
    [['create', '--name', 'x', '--contact', 'y', '--quota', '0'], '--quota must be a positive integer'],
    [['revoke', 'abc'], 'revoke needs a numeric key id'],
    [['revoke', '999'], 'No API key with id 999'],
  ])('reports CLI errors for %j', async (argv, message) => {
    const res = await cli(argv);
    expect(res.code).toBe(1);
    expect(res.err).toContain(message);
  });

  it('refuses to create keys without the HMAC secret', async () => {
    const res = await cli(['create', '--name', 'x', '--contact', 'y'], '');
    expect(res.code).toBe(1);
    expect(res.err).toContain('API_KEY_HMAC_SECRET is required');
  });

  it('accumulates flushed usage across flushes and processes', async () => {
    const { id } = await createKey();
    const a = new UsageRecorder(schema.pool);
    const b = new UsageRecorder(schema.pool);
    a.record(id, '2026-11-28', 2);
    b.record(id, '2026-11-28', 3);
    b.record(id, '2026-11-29');
    await Promise.all([a.flush(), b.flush()]);
    a.record(id, '2026-11-28');
    await a.flush();

    const { rows } = await schema.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, requests::int FROM api_key_usage WHERE key_id = $1 ORDER BY day`,
      [id]
    );
    expect(rows).toEqual([
      { day: '2026-11-28', requests: 6 },
      { day: '2026-11-29', requests: 1 },
    ]);
  });

  it('serves, counts, enforces quota and honours revocation end to end', async () => {
    const { id, key } = await createKey('--quota', '3');
    let clock = new Date();
    const auth = createApiKeyAuth({ db: schema.pool, secret: SECRET, cacheTtlMs: 1000, now: () => clock });
    const router = Router();
    router.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    const server = await serve({ '/r': router }, [auth.middleware]);
    const headers = { Authorization: `Bearer ${key}` };
    try {
      expect((await server.get('/r', headers)).status).toBe(200);
      expect((await server.get('/r', headers)).status).toBe(200);
      await auth.recorder.flush();
      clock = new Date(clock.getTime() + 2000); // reload from the database: 2 used
      expect((await server.get('/r', headers)).status).toBe(200);
      expect((await server.get('/r', headers)).status).toBe(429);

      // Revocation wins over quota and takes effect after the cache TTL.
      await cli(['revoke', String(id)]);
      clock = new Date(clock.getTime() + 2000);
      expect((await server.get('/r', headers)).body).toEqual({ error: 'API key has been revoked' });
      expect((await server.get('/r')).status).toBe(200); // anonymous still works
    } finally {
      await server.close();
      await auth.stop();
    }
    const { rows } = await schema.pool.query(
      'SELECT SUM(requests)::int AS n FROM api_key_usage WHERE key_id = $1',
      [id]
    );
    expect(rows[0].n).toBe(3);
  });
});
