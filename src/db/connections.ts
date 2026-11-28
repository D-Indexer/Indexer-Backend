import { Client, Pool, type PoolClient, type PoolConfig } from 'pg';

/**
 * Connection roles and PgBouncer compatibility.
 *
 * Managed Postgres is often fronted by PgBouncer in *transaction* pooling mode:
 * a client keeps a server connection only for the duration of one
 * transaction. Anything that relies on state surviving between transactions
 * on "the same connection" silently breaks there. Every DB usage in this
 * codebase falls into one of two classes:
 *
 * **Transaction-safe** (use the pooled `DATABASE_URL`):
 * - single-statement queries (API reads, `writeState`, `ensurePartitions`, ...);
 * - `BEGIN ... COMMIT` blocks on one checked-out client, including
 *   `SAVEPOINT`s and `pg_notify()` (delivered on commit) — e.g. `processPage`;
 * - per-transaction settings via `SET LOCAL` / `set_config(..., true)` (see
 *   `withTransaction`);
 * - parameterised queries: node-postgres uses the *unnamed* prepared
 *   statement unless a query sets `name`, which nothing here does.
 *
 * **Session-required** (use `DATABASE_DIRECT_URL`, see `getDirectDatabaseUrl`):
 * - session-level advisory locks (`migrate()` holds one across several
 *   transactions);
 * - `LISTEN` (cache invalidation, feature flags, `folder_indexed`
 *   subscribers): notifications are delivered to the session that listened;
 * - session-level `SET` (none in application code; use `SET LOCAL`);
 * - named prepared statements (none; avoid `{ name: ... }` queries);
 * - snapshot export, which reads in one REPEATABLE READ transaction while
 *   streaming (transaction-safe in principle, but long-lived, so it should
 *   not pin a pooled server connection).
 *
 * docs/operations.md#connection-pooling-pgbouncer is the operator-facing copy
 * of this list; keep the two in sync.
 */

/** Default size for pools of direct connections: they are few and short-lived. */
export const DIRECT_POOL_MAX = 2;

/**
 * Pool of direct (non-PgBouncer) connections for session-required work.
 * Kept small: these bypass the bouncer's connection cap.
 */
export function createDirectPool(
  connectionString: string,
  config: Omit<PoolConfig, 'connectionString'> = {}
): Pool {
  const pool = new Pool({ max: DIRECT_POOL_MAX, ...config, connectionString });
  // An idle client erroring (e.g. server restart) must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

/** A single direct connection, e.g. for a long-lived `LISTEN`. Caller connects and ends it. */
export function createDirectClient(connectionString: string): Client {
  return new Client({ connectionString });
}

const SETTING_NAME = /^[a-z_][a-z0-9_.]*$/i;

export type TransactionOptions = {
  /**
   * Settings applied with `set_config(name, value, true)` — the parameterised
   * form of `SET LOCAL` — so they last only until the transaction ends and
   * never leak to whichever client PgBouncer hands the server connection to
   * next. Use this instead of a session-level `SET`.
   */
  settings?: Record<string, string>;
};

/**
 * Run `fn` inside `BEGIN ... COMMIT` on one checked-out client, rolling back
 * on error. Transaction-pooling safe.
 */
export async function withTransaction<T>(
  db: Pick<Pool, 'connect'>,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [name, value] of Object.entries(options.settings ?? {})) {
      if (!SETTING_NAME.test(name)) throw new Error(`Invalid setting name: ${name}`);
      await client.query('SELECT set_config($1, $2, true)', [name, value]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres errors that retrying cannot fix: bad credentials, missing database. */
const FATAL_CONNECT_CODES = new Set(['28P01', '28000', '3D000']);

export type WaitForDatabaseOptions = {
  /** Give up after this long. Default 60s. */
  timeoutMs?: number;
  /** Cap on the backoff between attempts. Default 5s. */
  maxDelayMs?: number;
  logger?: { info: (msg: string, ctx?: Record<string, unknown>) => void };
};

/**
 * Retry `SELECT 1` with exponential backoff and jitter until Postgres answers,
 * so a process can start before its database. Fails fast on errors that a
 * retry cannot fix (see FATAL_CONNECT_CODES).
 */
export async function waitForDatabase(
  db: Pick<Pool, 'query'>,
  options: WaitForDatabaseOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (typeof code === 'string' && FATAL_CONNECT_CODES.has(code)) throw err;
      if (Date.now() >= deadline) throw err;
      const delay = Math.min(maxDelayMs, 250 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      options.logger?.info('Waiting for database', {
        attempt,
        delayMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
