/**
 * Connection-role tests: pooled (possibly PgBouncer, transaction mode) vs
 * direct connections. Skipped unless TEST_DATABASE_URL is set.
 *
 * In the CI `pgbouncer` job TEST_DATABASE_URL points at PgBouncer
 * (pool_mode=transaction) and TEST_DATABASE_DIRECT_URL at Postgres itself;
 * locally both may be the same direct URL, and every test still holds.
 */
import { Client, Pool } from 'pg';
import { createDirectPool, withTransaction } from '../db/connections';
import { migrate } from '../db/migrate';

const pooledUrl = process.env['TEST_DATABASE_URL'];
const directUrl = process.env['TEST_DATABASE_DIRECT_URL'] ?? pooledUrl;
const describeDb = pooledUrl ? describe : describe.skip;

const SCHEMA = 'pgbouncer_roles_test';
const silent = { info: () => undefined, warn: () => undefined };

describeDb('pooled vs direct connections', () => {
  let pooled: Pool;

  beforeAll(async () => {
    pooled = new Pool({ connectionString: pooledUrl, max: 10 });
    const direct = createDirectPool(directUrl!, { options: `-c search_path=${SCHEMA}` });
    try {
      await pooled.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pooled.query(`CREATE SCHEMA ${SCHEMA}`);
      // Migrations need the session-level advisory lock: direct connection.
      await migrate(direct, { logger: silent });
    } finally {
      await direct.end();
    }
  });

  afterAll(async () => {
    await pooled.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pooled.end();
  });

  it('scopes settings to the transaction with SET LOCAL semantics', async () => {
    const inside = await withTransaction(
      pooled,
      async (c) =>
        (await c.query<{ v: string }>(`SELECT current_setting('statement_timeout') AS v`)).rows[0]!.v,
      { settings: { statement_timeout: '1234ms' } }
    );
    expect(inside).toBe('1234ms');

    // Whichever server connection PgBouncer hands out next, nothing leaked.
    const after = await Promise.all(
      Array.from({ length: 10 }, () =>
        pooled.query<{ v: string }>(`SELECT current_setting('statement_timeout') AS v`)
      )
    );
    expect(after.map((r) => r.rows[0]!.v)).not.toContain('1234ms');
  });

  it('runs schema-scoped work through the pool via SET LOCAL search_path', async () => {
    await withTransaction(
      pooled,
      (c) =>
        c.query(
          `INSERT INTO indexer_state (key, value) VALUES ('cursor', 'c-1')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
        ),
      { settings: { search_path: SCHEMA } }
    );
    const { rows } = await pooled.query(`SELECT value FROM ${SCHEMA}.indexer_state WHERE key = 'cursor'`);
    expect(rows).toEqual([{ value: 'c-1' }]);
  });

  it('rejects setting names that are not identifiers', async () => {
    await expect(
      withTransaction(pooled, async () => undefined, { settings: { 'x; DROP TABLE y': '1' } })
    ).rejects.toThrow(/Invalid setting name/);
  });

  it('rolls back on error', async () => {
    await expect(
      withTransaction(pooled, async (c) => {
        await c.query(`INSERT INTO ${SCHEMA}.indexer_state (key, value) VALUES ('rollback', 'x')`);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const { rows } = await pooled.query(`SELECT 1 FROM ${SCHEMA}.indexer_state WHERE key = 'rollback'`);
    expect(rows).toHaveLength(0);
  });

  it('delivers NOTIFY sent in a pooled transaction to a direct LISTEN session', async () => {
    const listener = new Client({ connectionString: directUrl });
    await listener.connect();
    try {
      await listener.query('LISTEN pgbouncer_roles_test');
      const received = new Promise<string | undefined>((resolve) =>
        listener.on('notification', (msg) => resolve(msg.payload))
      );
      await withTransaction(pooled, (c) => c.query(`SELECT pg_notify('pgbouncer_roles_test', 'hello')`));
      await expect(received).resolves.toBe('hello');
    } finally {
      await listener.end();
    }
  });

  it('serves concurrent parameterised queries (unnamed statements) through the pool', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => pooled.query<{ n: number }>('SELECT $1::int + 1 AS n', [i]))
    );
    expect(results.map((r) => r.rows[0]!.n)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});
