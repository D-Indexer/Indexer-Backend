import { Pool } from 'pg';
import { getEnv } from '../config/env';

const env = getEnv();

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
});

export default pool;

/**
 * Minimal interface for a pool-like object that can run a query.
 * Kept narrow so tests can pass a fake pool.
 */
export interface QueryablePool {
  query: (text: string) => Promise<unknown>;
}

export interface WaitForDatabaseOptions {
  /** Total time to keep retrying before giving up. */
  timeoutMs: number;
  /** Upper bound for the backoff delay between attempts. */
  maxDelayMs: number;
  /** Optional logger; defaults to console. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Optional sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional random injection for tests (should return [0, 1)). */
  random?: () => number;
}

/**
 * Postgres error codes that indicate a misconfiguration which retrying
 * will never fix. We exit immediately on these.
 */
const FATAL_PG_CODES = new Set<string>([
  '28P01', // invalid_password (auth failure)
  '3D000', // invalid_catalog_name (database does not exist)
]);

/**
 * Returns true if the given error is a fatal, non-retryable database error.
 */
export function isFatalDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && FATAL_PG_CODES.has(code);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the database to become reachable by retrying `SELECT 1`
 * with exponential backoff and jitter.
 *
 * - Retries until `timeoutMs` elapses.
 * - Backoff doubles each attempt, capped at `maxDelayMs`, with jitter.
 * - Throws immediately on fatal errors (auth failure, missing database).
 * - Throws a descriptive error if the timeout is exceeded.
 */
export async function waitForDatabase(
  pool: QueryablePool,
  options: WaitForDatabaseOptions,
): Promise<void> {
  const { timeoutMs, maxDelayMs } = options;
  const logger = options.logger ?? console;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const startedAt = Date.now();
  let attempt = 0;
  let delay = Math.min(1000, maxDelayMs);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) {
        logger.info(
          `[db] database reachable after ${attempt} attempt(s) (${Date.now() - startedAt}ms)`,
        );
      } else {
        logger.info('[db] database reachable');
      }
      return;
    } catch (error) {
      if (isFatalDatabaseError(error)) {
        const code = (error as { code?: string }).code;
        const message = (error as { message?: string }).message ?? 'unknown error';
        logger.error(
          `[db] fatal database error (code ${code}): ${message}. Not retrying.`,
        );
        throw error;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `[db] database not reachable after ${attempt} attempt(s) in ${elapsed}ms: ${message}`,
        );
        throw new Error(
          `Timed out waiting for database after ${elapsed}ms (${attempt} attempts): ${message}`,
        );
      }

      // Exponential backoff with jitter: delay in [delay/2, delay].
      const jittered = Math.floor(delay / 2 + random() * (delay / 2));
      const remaining = timeoutMs - elapsed;
      const waitMs = Math.max(0, Math.min(jittered, remaining));

      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[db] database not ready (attempt ${attempt}, ${elapsed}ms elapsed): ${message}. Retrying in ${waitMs}ms.`,
      );

      await sleep(waitMs);

      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}