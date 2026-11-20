import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { Cache } from '../cache/index.js';
import { ListenManager } from '../db/listen.js';

const DATABASE_URL = process.env.DATABASE_URL;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('cache Postgres-backed invalidation', () => {
  let pool: Pool;
  let listenManager: ListenManager;
  let cache: Cache;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    cache = new Cache();
    listenManager = new ListenManager({
      connectionString: DATABASE_URL!,
      channel: 'cache_invalidation_test',
      onNotify: (payload) => {
        if (payload && typeof payload.tag === 'string') {
          cache.invalidateTag(payload.tag);
        }
      },
      onReconnect: () => {
        cache.flush();
      },
    });
    await listenManager.start();
  });

  afterEach(async () => {
    await listenManager.stop();
    cache.clear();
  });

  it('invalidates tagged entries within one NOTIFY round trip', async () => {
    cache.set('indexer_state:1', { ledger: 100 }, { ttlMs: 60_000, tags: ['indexer_state'] });
    cache.set('template:list', [{ id: 'a' }], { ttlMs: 60_000, tags: ['template'] });
    cache.set('stats', { total: 5 }, { ttlMs: 60_000, tags: ['stats'] });

    expect(cache.get('indexer_state:1')).toEqual({ ledger: 100 });
    expect(cache.get('template:list')).toEqual([{ id: 'a' }]);
    expect(cache.get('stats')).toEqual({ total: 5 });

    await pool.query(`NOTIFY cache_invalidation_test, $1`, [
      JSON.stringify({ tag: 'indexer_state' }),
    ]);

    await waitFor(() => cache.get('indexer_state:1') === undefined, 2000);

    expect(cache.get('indexer_state:1')).toBeUndefined();
    expect(cache.get('template:list')).toEqual([{ id: 'a' }]);
    expect(cache.get('stats')).toEqual({ total: 5 });
  });

  it('invalidates multiple tags across separate NOTIFY messages', async () => {
    cache.set('template:list', [{ id: 'a' }], { ttlMs: 60_000, tags: ['template'] });
    cache.set('template:detail:a', { id: 'a' }, { ttlMs: 60_000, tags: ['template'] });
    cache.set('stats', { total: 5 }, { ttlMs: 60_000, tags: ['stats'] });

    await pool.query(`NOTIFY cache_invalidation_test, $1`, [
      JSON.stringify({ tag: 'template' }),
    ]);
    await waitFor(() => cache.get('template:list') === undefined, 2000);

    expect(cache.get('template:list')).toBeUndefined();
    expect(cache.get('template:detail:a')).toBeUndefined();
    expect(cache.get('stats')).toEqual({ total: 5 });

    await pool.query(`NOTIFY cache_invalidation_test, $1`, [
      JSON.stringify({ tag: 'stats' }),
    ]);
    await waitFor(() => cache.get('stats') === undefined, 2000);

    expect(cache.get('stats')).toBeUndefined();
  });

  it('serves stale data until TTL when LISTEN is down, then flushes on reconnect', async () => {
    cache.set('indexer_state:1', { ledger: 100 }, { ttlMs: 60_000, tags: ['indexer_state'] });
    expect(cache.get('indexer_state:1')).toEqual({ ledger: 100 });

    await listenManager.stop();

    await pool.query(`NOTIFY cache_invalidation_test, $1`, [
      JSON.stringify({ tag: 'indexer_state' }),
    ]);

    // Give the NOTIFY time to be delivered (it won't be, since LISTEN is down).
    await sleep(300);

    // Cache still serves the stale value because LISTEN is down.
    expect(cache.get('indexer_state:1')).toEqual({ ledger: 100 });

    await listenManager.start();

    // On reconnect the cache is flushed.
    await waitFor(() => cache.get('indexer_state:1') === undefined, 2000);
    expect(cache.get('indexer_state:1')).toBeUndefined();
  });

  it('bounds staleness by TTL when LISTEN is down', async () => {
    cache.set('indexer_state:1', { ledger: 100 }, { ttlMs: 100, tags: ['indexer_state'] });
    expect(cache.get('indexer_state:1')).toEqual({ ledger: 100 });

    await listenManager.stop();

    await sleep(150);

    expect(cache.get('indexer_state:1')).toBeUndefined();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('Timed out waiting for condition');
}