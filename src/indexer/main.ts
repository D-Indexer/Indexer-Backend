import 'dotenv/config';
import { createContainer } from '../container';
import { getDirectDatabaseUrl } from '../config/env';
import { createDirectPool } from '../db/connections';
import { migrate } from '../db/migrate';
import { logger } from '../utils/logger';
import { redactUrl } from './rpc';
import { createIndexer } from './stellar';
import { createHealthServer } from './httpHealth';

/** Indexer process entrypoint: `npm run start:indexer` (or `dev:indexer`). */
async function main(): Promise<void> {
  const container = createContainer();
  const { db, env } = container;

  // Migrations hold a session-level advisory lock, so they run on a short-lived
  // direct connection (DATABASE_DIRECT_URL) even when `db` goes through PgBouncer.
  const migrationPool = createDirectPool(getDirectDatabaseUrl(env));
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

  const shutdown = async (signal: string) => {
    logger.info('Shutdown requested', { signal });
    const timeout = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    await health.stop();
    await indexer.stop();
    await db.end();
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
