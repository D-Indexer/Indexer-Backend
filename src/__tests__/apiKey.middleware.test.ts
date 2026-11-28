import { Router } from 'express';
import { createApiKeyAuth, type ApiKeyAuth } from '../middleware/apiKey';
import { generateApiKey, hashApiKey, UsageRecorder } from '../services/apiKeys';
import { logger } from '../utils/logger';
import { serve, type TestServer } from './httpHarness';

const SECRET = 'test-secret-test-secret-test-secret-0123';

interface FakeKey {
  id: number;
  name: string;
  revoked_at: Date | null;
  monthly_quota: number | null;
  month_requests: number;
}

/** In-memory stand-in for the two queries the middleware and recorder issue. */
function fakeDb() {
  const keys = new Map<string, FakeKey>();
  const flushed: { ids: number[]; days: string[]; requests: number[] }[] = [];
  const allParams: unknown[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    allParams.push(...params.flat());
    if (sql.includes('FROM api_keys k WHERE k.key_hash = $1')) {
      const key = keys.get(params[0] as string);
      return {
        rows: key
          ? [
              {
                id: String(key.id),
                name: key.name,
                contact: 'ops@example.com',
                created_at: new Date(),
                revoked_at: key.revoked_at,
                monthly_quota: key.monthly_quota === null ? null : String(key.monthly_quota),
                month_requests: String(key.month_requests),
              },
            ]
          : [],
      };
    }
    if (sql.includes('INSERT INTO api_key_usage')) {
      const [ids, days, requests] = params as [number[], string[], number[]];
      flushed.push({ ids, days, requests });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  function addKey(fields: Partial<FakeKey> = {}): { key: string; record: FakeKey } {
    const key = generateApiKey();
    const record: FakeKey = {
      id: keys.size + 1,
      name: 'Explorer Inc',
      revoked_at: null,
      monthly_quota: null,
      month_requests: 0,
      ...fields,
    };
    keys.set(hashApiKey(SECRET, key), record);
    return { key, record };
  }
  return { db: { query } as any, query, addKey, flushed, allParams };
}

describe('API key middleware', () => {
  let fake: ReturnType<typeof fakeDb>;
  let auth: ApiKeyAuth;
  let server: TestServer;
  let clock: Date;

  beforeEach(async () => {
    fake = fakeDb();
    clock = new Date('2026-11-28T12:00:00Z');
    auth = createApiKeyAuth({
      db: fake.db,
      secret: SECRET,
      cacheTtlMs: 30_000,
      flushIntervalMs: 60 * 60 * 1000,
      now: () => clock,
    });
    const router = Router();
    router.get('/', (_req, res) => {
      res.json({ ok: true, apiKey: res.locals['apiKey'] ?? null });
    });
    server = await serve({ '/things': router }, [auth.middleware]);
  });
  afterEach(async () => {
    await server.close();
    await auth.stop();
  });

  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  it('lets anonymous requests through without touching the database', async () => {
    const res = await server.get('/things');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, apiKey: null });
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('attributes a valid key and counts its usage', async () => {
    const { key, record } = fake.addKey();

    const res = await server.get('/things', bearer(key));
    await server.get('/things', bearer(key));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, apiKey: { id: record.id, name: 'Explorer Inc' } });
    expect(auth.recorder.pending(record.id, '2026-11-01')).toBe(2);
    // Cached: one lookup for two requests.
    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it('accepts a lowercase bearer scheme', async () => {
    const { key } = fake.addKey();
    const res = await server.get('/things', { Authorization: `bearer ${key}` });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown key with 401', async () => {
    const res = await server.get('/things', bearer(generateApiKey()));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid API key' });
  });

  it('rejects a revoked key with 401', async () => {
    const { key } = fake.addKey({ revoked_at: new Date('2026-11-01T00:00:00Z') });

    const res = await server.get('/things', bearer(key));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'API key has been revoked' });
  });

  it.each([
    [
      'a non-Bearer scheme',
      'Basic dXNlcjpwYXNz',
      'Malformed Authorization header: expected "Bearer <API key>"',
    ],
    ['a missing token', 'Bearer', 'Malformed Authorization header: expected "Bearer <API key>"'],
    ['two tokens', 'Bearer fk_a fk_b', 'Malformed Authorization header: expected "Bearer <API key>"'],
    ['a malformed key', 'Bearer not-a-real-key', 'Malformed API key'],
    ['a truncated key', `Bearer ${generateApiKey().slice(0, 20)}`, 'Malformed API key'],
  ])('rejects %s with 401 without querying', async (_label, header, error) => {
    const res = await server.get('/things', { Authorization: header });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error });
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('rejects a key once revoked, within the cache TTL', async () => {
    const { key, record } = fake.addKey();
    expect((await server.get('/things', bearer(key))).status).toBe(200);

    record.revoked_at = new Date();
    clock = new Date(clock.getTime() + 29_000);
    expect((await server.get('/things', bearer(key))).status).toBe(200); // still cached

    clock = new Date(clock.getTime() + 2_000); // TTL elapsed
    const res = await server.get('/things', bearer(key));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'API key has been revoked' });
  });

  it('returns 429 with a clear error and Retry-After once the monthly quota is used', async () => {
    const { key } = fake.addKey({ monthly_quota: 3, month_requests: 1 });

    expect((await server.get('/things', bearer(key))).status).toBe(200);
    expect((await server.get('/things', bearer(key))).status).toBe(200);
    const res = await server.get('/things', bearer(key));

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: 'Monthly quota of 3 requests exceeded for this API key; it resets at 2026-12-01T00:00:00.000Z',
    });
    // 2026-11-28T12:00Z to 2026-12-01T00:00Z
    expect(res.headers.get('retry-after')).toBe(String(2.5 * 24 * 3600));
  });

  it('counts unflushed usage from this process when a cache entry is refreshed', async () => {
    const { key, record } = fake.addKey({ monthly_quota: 2 });
    expect((await server.get('/things', bearer(key))).status).toBe(200);
    expect((await server.get('/things', bearer(key))).status).toBe(200);

    clock = new Date(clock.getTime() + 60_000); // reload; DB still says 0, 2 pending in memory
    expect(record.month_requests).toBe(0);
    expect((await server.get('/things', bearer(key))).status).toBe(429);
  });

  it('starts a fresh quota when the month rolls over', async () => {
    const { key, record } = fake.addKey({ monthly_quota: 1, month_requests: 1 });
    expect((await server.get('/things', bearer(key))).status).toBe(429);

    record.month_requests = 0; // the new month has no usage rows yet
    clock = new Date('2026-12-01T00:00:01Z');
    expect((await server.get('/things', bearer(key))).status).toBe(200);
  });

  it('never sends, logs or returns the plaintext key', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => undefined)
    );
    const { key } = fake.addKey();
    const unknown = generateApiKey();

    const responses = [
      await server.get('/things', bearer(key)),
      await server.get('/things', bearer(unknown)),
    ];
    await auth.recorder.flush();

    for (const secretKey of [key, unknown]) {
      expect(fake.allParams).not.toContain(secretKey);
      expect(JSON.stringify(fake.allParams)).not.toContain(secretKey);
      for (const res of responses) expect(JSON.stringify(res.body)).not.toContain(secretKey);
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secretKey);
    }
    expect(fake.allParams).toContain(hashApiKey(SECRET, key));
    spies.forEach((spy) => spy.mockRestore());
  });
});

describe('UsageRecorder', () => {
  it('aggregates per key and day and flushes them as one upsert', async () => {
    const fake = fakeDb();
    const recorder = new UsageRecorder(fake.db);
    recorder.record(1, '2026-11-28');
    recorder.record(1, '2026-11-28');
    recorder.record(1, '2026-11-29');
    recorder.record(2, '2026-11-28', 5);

    await expect(recorder.flush()).resolves.toBe(3);

    expect(fake.query).toHaveBeenCalledTimes(1);
    expect(fake.flushed).toEqual([
      { ids: [1, 1, 2], days: ['2026-11-28', '2026-11-29', '2026-11-28'], requests: [2, 1, 5] },
    ]);
    expect(recorder.pending(1, '2026-11-01')).toBe(0);
    await expect(recorder.flush()).resolves.toBe(0);
    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it('keeps counts from a failed flush and retries them with newer counts', async () => {
    const fake = fakeDb();
    const recorder = new UsageRecorder(fake.db);
    recorder.record(1, '2026-11-28', 3);
    fake.query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(recorder.flush()).rejects.toThrow('connection lost');
    expect(recorder.pending(1, '2026-11-01')).toBe(3);

    recorder.record(1, '2026-11-28');
    await recorder.flush();
    expect(fake.flushed).toEqual([{ ids: [1], days: ['2026-11-28'], requests: [4] }]);
  });

  it('shares one in-flight flush between concurrent callers', async () => {
    const fake = fakeDb();
    const recorder = new UsageRecorder(fake.db);
    recorder.record(1, '2026-11-28');

    await Promise.all([recorder.flush(), recorder.flush()]);

    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it('only counts pending usage on or after the given day', () => {
    const recorder = new UsageRecorder(fakeDb().db);
    recorder.record(1, '2026-10-31', 7);
    recorder.record(1, '2026-11-01', 2);
    recorder.record(2, '2026-11-02', 4);
    expect(recorder.pending(1, '2026-11-01')).toBe(2);
  });

  it('flushes periodically and on stop', async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeDb();
      const recorder = new UsageRecorder(fake.db);
      const onError = jest.fn();
      recorder.start(1000, onError);
      recorder.record(1, '2026-11-28');

      await jest.advanceTimersByTimeAsync(1000);
      expect(fake.flushed).toHaveLength(1);

      recorder.record(1, '2026-11-28');
      await recorder.stop();
      expect(fake.flushed).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(5000);
      expect(fake.flushed).toHaveLength(2);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
