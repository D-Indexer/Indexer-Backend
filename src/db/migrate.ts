import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Pool, PoolClient } from 'pg';
import { logger as defaultLogger } from '../utils/logger';

/**
 * database/schema.sql is the single source of truth for the schema.
 *
 * Resolution order:
 * 1. `SCHEMA_PATH` env override (absolute or relative to cwd).
 * 2. `../../database/schema.sql` relative to this file — works when running
 *    from source via tsx (`src/db/migrate.ts`).
 * 3. `../database/schema.sql` relative to this file — works when bundled into
 *    a single file at the project root (e.g. `dist/indexer.js`).
 */
function resolveSchemaPath(): string {
  const override = process.env.SCHEMA_PATH;
  if (override) {
    return path.resolve(override);
  }
  const candidates = [
    path.resolve(__dirname, '../../database/schema.sql'),
    path.resolve(__dirname, '../database/schema.sql'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export const SCHEMA_PATH = resolveSchemaPath();

export function loadSchemaSql(schemaPath = SCHEMA_PATH): string {
  return readFileSync(schemaPath, 'utf8');
}

/**
 * Key for the session-level advisory lock that serialises migrations.
 *
 * `CREATE ... IF NOT EXISTS` is not concurrency-safe in Postgres: two sessions
 * can both see "does not exist" and then race on the catalog, failing with
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`
 * or deadlocking on catalog locks. Every migrator takes this lock first, so
 * only one applies the schema at a time and the rest find it already there.
 *
 * The value is the ASCII bytes of "FoldrMig" read as a signed 64-bit integer.
 * It is a constant (not derived from the schema name) so that every process
 * pointed at the same database contends on the same lock. Advisory locks are
 * database-wide, so this also serialises migrations of different schemas in
 * one database, which is harmless.
 */
export const MIGRATION_LOCK_KEY = '5075394483740043623';

/**
 * The pre-testnet schema had `folders.cid` and a `credentials` table that no
 * contract event populates. Refuse to run on top of it rather than silently
 * mixing the two layouts.
 */
export async function assertNoLegacySchema(db: Pick<Pool, 'query'>): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'folders' AND column_name = 'cid'`
  );
  if (rows.length > 0) {
    throw new Error(
      'Legacy schema detected (folders.cid). The previous indexer could not decode the deployed ' +
        'contract, so these tables hold no indexed data. Drop them and re-run the migration: ' +
        'DROP TABLE IF EXISTS credentials, folders, templates, indexer_state CASCADE; ' +
        '(see docs/operations.md)'
    );
  }
}

type MigrateLogger = Pick<typeof defaultLogger, 'info' | 'warn'>;

/** A step run after the schema is applied, while the migration lock is still held. */
export type PostSchemaStep = (client: PoolClient, logger: MigrateLogger) => Promise<void>;

export type MigrateOptions = {
  /** Schema SQL to apply. Defaults to `database/schema.sql`. */
  schemaSql?: string;
  logger?: MigrateLogger;
  /**
   * Steps that need more than one transaction (e.g. batched data conversions).
   * They run in order on the locked connection after the schema transaction
   * commits.
   */
  postSchemaSteps?: PostSchemaStep[];
};

/**
 * Take the migration advisory lock on `client`, logging how long it waited.
 * `pg_try_advisory_lock` first, so the common uncontended case logs nothing
 * alarming and a contended start says why it is pausing.
 */
async function acquireMigrationLock(client: PoolClient, logger: MigrateLogger): Promise<number> {
  const started = Date.now();
  const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
    MIGRATION_LOCK_KEY,
  ]);
  if (!rows[0]?.locked) {
    logger.info('Waiting for migration lock held by another process', { lockKey: MIGRATION_LOCK_KEY });
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  }
  const waitedMs = Date.now() - started;
  logger.info('Acquired migration lock', { lockKey: MIGRATION_LOCK_KEY, waitedMs });
  return waitedMs;
}

/**
 * Apply `database/schema.sql`, safely under concurrency.
 *
 * - Checks out one dedicated connection and holds a session-level
 *   `pg_advisory_lock(MIGRATION_LOCK_KEY)` on it for the whole migration, so
 *   concurrent callers (two indexer replicas, a migration job racing the
 *   indexer) run one at a time instead of racing on the catalog.
 * - Applies the schema inside a single transaction, so a failure leaves no
 *   half-applied schema behind.
 * - Releases the lock in `finally`. If the unlock itself fails the connection
 *   is destroyed instead of being returned to the pool, which ends the session
 *   and so releases the lock server-side.
 *
 * Session-level advisory locks need a real Postgres session: pass a pool built
 * from `DATABASE_DIRECT_URL`, not one that goes through PgBouncer in
 * transaction mode (see docs/operations.md#connection-pooling-pgbouncer).
 */
export async function migrate(db: Pick<Pool, 'connect'>, options: MigrateOptions = {}): Promise<void> {
  const logger = options.logger ?? defaultLogger;
  const schemaSql = options.schemaSql ?? loadSchemaSql();
  const client = await db.connect();
  let releaseError: Error | undefined;

  try {
    await acquireMigrationLock(client, logger);
    try {
      await assertNoLegacySchema(client);
      await client.query('BEGIN');
      try {
        await client.query(schemaSql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      for (const step of options.postSchemaSteps ?? defaultPostSchemaSteps()) {
        await step(client, logger);
      }
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch (err) {
        releaseError = err instanceof Error ? err : new Error(String(err));
        logger.warn('Failed to release migration lock; discarding the connection', {
          error: releaseError.message,
        });
      }
    }
  } catch (err) {
    releaseError ??= err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    // Passing an error destroys the connection rather than pooling it, so a
    // lock we could not release explicitly cannot outlive this call.
    client.release(releaseError);
  }
}

/** Data migrations that run after the schema on every `migrate()`. */
function defaultPostSchemaSteps(): PostSchemaStep[] {
  return [];
}

if (require.main === module) {
  // Imported lazily so loading this module (e.g. in tests) doesn't need env.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pool: Pool = require('./client').default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { waitForDatabase } = require('./client');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('../config/env');
  waitForDatabase(pool, {
    timeoutMs: env.DB_WAIT_TIMEOUT_MS,
    maxDelayMs: env.DB_WAIT_MAX_DELAY_MS,
  })
    .then(() => migrate(pool))
    .then(() => defaultLogger.info('Migrations applied'))
    .catch((err: unknown) => {
      defaultLogger.error('Migration failed', { error: err instanceof Error ? err.message : err });
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
