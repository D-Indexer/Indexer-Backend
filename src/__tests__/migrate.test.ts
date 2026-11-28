/**
 * Concurrency tests for migrate(). Skipped unless TEST_DATABASE_URL is set.
 *
 * Each test works in its own throwaway schema (selected per connection via the
 * `search_path` startup option), so it never touches `public`.
 */
import { Client, Pool } from 'pg';
import { loadSchemaSql, migrate, MIGRATION_LOCK_KEY } from '../db/migrate';

const url = process.env.TEST_DATABASE_URL;
// Session-level advisory locks need a direct (non-PgBouncer) session.
const directUrl = process.env.TEST_DATABASE_DIRECT_URL ?? url;
const describeDb = url ? describe : describe.skip;

const SCHEMA = 'migrate_concurrency_test';
const silent = { info: () => undefined, warn: () => undefined };

function schemaPool(max = 1): Pool {
  return new Pool({ connectionString: directUrl, max, options: `-c search_path=${SCHEMA}` });
}

async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: directUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetSchema(): Promise<void> {
  await admin((c) => c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`));
}

async function heldMigrationLocks(): Promise<number> {
  // A bigint advisory lock is stored as (classid = high 32 bits, objid = low 32 bits).
  const key = BigInt(MIGRATION_LOCK_KEY);
  const high = Number((key >> 32n) & 0xffffffffn);
  const low = Number(key & 0xffffffffn);
  return admin(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND classid = $1::bigint::oid AND objid = $2::bigint::oid`,
      [high, low]
    );
    return rows[0].n;
  });
}

describeDb('migrate() under concurrency', () => {
  afterAll(async () => {
    await admin((c) => c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
  });

  it('succeeds every time when run 10x concurrently against an empty schema', async () => {
    for (let round = 0; round < 5; round++) {
      await resetSchema();
      // One pool per migrator, so each gets its own session like separate replicas.
      const pools = Array.from({ length: 10 }, () => schemaPool());
      try {
        const results = await Promise.allSettled(pools.map((p) => migrate(p, { logger: silent })));
        const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(failures.map((f) => String(f.reason))).toEqual([]);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }

      const tables = await admin(async (c) => {
        const { rows } = await c.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
          [SCHEMA]
        );
        return rows.map((r) => r.table_name);
      });
      expect(tables).toEqual(
        expect.arrayContaining(['contract_events', 'folders', 'templates', 'portfolios', 'indexer_state'])
      );
      expect(await heldMigrationLocks()).toBe(0);
    }
  });

  it('is idempotent when re-run sequentially', async () => {
    await resetSchema();
    const pool = schemaPool();
    try {
      await migrate(pool, { logger: silent });
      await migrate(pool, { logger: silent });
    } finally {
      await pool.end();
    }
  });

  it('logs the lock wait time, and waits while another session holds the lock', async () => {
    await resetSchema();
    const holder = new Client({ connectionString: directUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const infos: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const logger = {
      info: (msg: string, ctx?: Record<string, unknown>) => infos.push({ msg, ctx }),
      warn: () => undefined,
    };
    const pool = schemaPool();
    try {
      const running = migrate(pool, { logger });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(infos.map((i) => i.msg)).toEqual(['Waiting for migration lock held by another process']);

      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      await running;

      const acquired = infos.find((i) => i.msg === 'Acquired migration lock');
      expect(acquired?.ctx?.waitedMs).toBeGreaterThanOrEqual(250);
    } finally {
      await holder.end();
      await pool.end();
    }
  });

  it('rolls back a failing schema and still releases the lock', async () => {
    await resetSchema();
    const pool = schemaPool();
    const broken = `${loadSchemaSql()}\nCREATE TABLE this_is_not_valid (;`;
    try {
      await expect(migrate(pool, { schemaSql: broken, logger: silent })).rejects.toThrow(/syntax error/);
    } finally {
      await pool.end();
    }
    // Nothing from the failed transaction was committed.
    const tables = await admin(async (c) => {
      const { rows } = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1`, [
        SCHEMA,
      ]);
      return rows.length;
    });
    expect(tables).toBe(0);
    expect(await heldMigrationLocks()).toBe(0);
  });

  it('releases the lock when a post-schema step fails', async () => {
    await resetSchema();
    const pool = schemaPool();
    try {
      await expect(
        migrate(pool, {
          logger: silent,
          postSchemaSteps: [
            async () => {
              throw new Error('step failed');
            },
          ],
        })
      ).rejects.toThrow('step failed');
    } finally {
      await pool.end();
    }
    expect(await heldMigrationLocks()).toBe(0);
  });
});
