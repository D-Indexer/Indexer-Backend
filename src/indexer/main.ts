import 'dotenv/config';
import { getEnv } from '../config/env';
import pool from '../db/client';
import { migrate } from '../db/migrate';
import { logger } from '../utils/logger';
import { createRpcClient, redactUrl } from './rpc';
import { createIndexer } from './stellar';

/** Indexer process entrypoint: `npm run start:indexer` (or `dev:indexer`). */
async function main(): Promise<void> {
  const env = getEnv();
  await migrate(pool);

  const rpc = createRpcClient({ url: env.STELLAR_RPC_URL, timeoutMs: env.STELLAR_RPC_TIMEOUT_MS });
  logger.info('Connecting indexer', { rpc: redactUrl(env.STELLAR_RPC_URL) });

  const indexer = createIndexer({
    db: pool,
    rpc,
    config: {
      contractId: env.FOLDER_CONTRACT_ID,
      pollIntervalMs: env.INDEXER_POLL_INTERVAL_MS,
      pageLimit: env.INDEXER_PAGE_LIMIT,
      startLedger: env.INDEXER_START_LEDGER,
      onRetentionGap: env.INDEXER_ON_RETENTION_GAP,
      maxBackoffMs: env.INDEXER_MAX_BACKOFF_MS,
    },
  });

  const shutdown = async (signal: string) => {
    logger.info('Shutdown requested', { signal });
    const timeout = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    await indexer.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Indexer failed to start', { error: err instanceof Error ? err.message : err });
  process.exit(1);
});
