import 'dotenv/config';
import { createContainer } from '../container';
import { migrate } from '../db/migrate';
import { logger } from '../utils/logger';
import { redactUrl } from './rpc';
import { createIndexer } from './stellar';

/** Indexer process entrypoint: `npm run start:indexer` (or `dev:indexer`). */
async function main(): Promise<void> {
  const container = createContainer();
  const { db, env } = container;

  await migrate(db);

  logger.info('Connecting indexer', { rpc: redactUrl(env.STELLAR_RPC_URL) });

  const indexer = createIndexer(container.deps);

  const shutdown = async (signal: string) => {
    logger.info('Shutdown requested', { signal });
    const timeout = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    await indexer.stop();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Indexer failed to start', { error: err instanceof Error ? err.message : err });
  process.exit(1);
});
