import 'dotenv/config';
import { Client, Pool } from 'pg';
import { getDirectDatabaseUrl } from '../config/env';
import { createContainer } from '../container';
import { migrate } from '../db/migrate';
import { logger } from '../utils/logger';
import { redactUrl } from './rpc';
import { createIndexer } from './stellar';
import { createHealthServer } from './httpHealth';

/** Indexer process entrypoint: `npm run start:indexer` (or `dev:indexer`). */
async function main(): Promise<void> {
  const container = createContainer();
  const { db, env } = container;

  // Migrations are session-required: run them on a short-lived direct
  // connection, never through a transaction-mode pooler.
  const migrationPool = new Pool({ connectionString: getDirectDatabaseUrl(env), max: 1 });
  try {
    await migrate(migrationPool);
  } finally {
    await migrationPool.end();
  }

  logger.info('Connecting indexer', { rpc: redactUrl(env.STELLAR_RPC_URL) });

  const indexer = createIndexer(container.deps);

  // Start the cache LISTEN connection so this process receives NOTIFY messages
  // and invalidates its in-process cache. The indexer publishes NOTIFY messages
  // after applying events (see the publish point in src/indexer/stellar.ts);
  // if the LISTEN connection is down, cache staleness is bounded by the TTL.
  await startCacheListener();

  health.start();

  // Hold the indexer lock for the life of the process so `retry-rejected`
  // refuses to write the read model concurrently. This is a session-level
  // lock, so it needs a dedicated direct connection: through PgBouncer in
  // transaction mode the lock would land on a shared server connection and
  // either leak to other clients or vanish. See docs/database-connections.md.
  const lockClient = new Client({ connectionString: getDirectDatabaseUrl(env) });
  await lockClient.connect();
  if (!(await tryLockIndexer(lockClient))) {
    await lockClient.end();
    throw new Error('Another indexer process holds the indexer lock');
  }

  const shutdown = async (signal: string) => {
    logger.info('Shutdown requested', { signal });
    const timeout = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    await health.stop();
    await indexer.stop();
    await db.end();
    await lockClient.end().catch(() => undefined);
    process.exit(0);
  };

  installProcessHandlers({
    logger,
    shutdown,
    isProduction: env.NODE_ENV === 'production',
  });
}

main().catch((err) => {
  logger.error('Indexer failed to start', {
    error: err instanceof Error ? err.message : err,
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
