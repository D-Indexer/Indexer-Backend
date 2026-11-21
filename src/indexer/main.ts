import 'dotenv/config';
import { getEnv, rpcUrls } from '../config/env';
import pool from '../db/client';
import { migrate } from '../db/migrate';
import { logger } from '../utils/logger';
import { createFailoverEventSource, createRpcClient, redactUrl } from './rpc';
import { createIndexer, ledgerFromCursor, readState, STATE } from './stellar';

/** Indexer process entrypoint: `npm run start:indexer` (or `dev:indexer`). */
async function main(): Promise<void> {
  const env = getEnv();
  await migrate(pool);

  const urls = rpcUrls(env);
  const rpc =
    urls.length > 1
      ? createFailoverEventSource({
          urls,
          timeoutMs: env.STELLAR_RPC_TIMEOUT_MS,
          failureThreshold: env.STELLAR_RPC_FAILURE_THRESHOLD,
          cooldownMs: env.STELLAR_RPC_COOLDOWN_MS,
          cursorLedger: () => {
            const cursor = lastCursor;
            if (!cursor) return undefined;
            try {
              return ledgerFromCursor(cursor);
            } catch {
              return undefined;
            }
          },
        })
      : createRpcClient({ url: urls[0], timeoutMs: env.STELLAR_RPC_TIMEOUT_MS });
  logger.info('Connecting indexer', { rpc: urls.map(redactUrl) });

  // Cached so the failover source can skip endpoints behind the saved cursor.
  let lastCursor: string | undefined;
  const refreshCursor = async () => {
    lastCursor = (await readState(pool))[STATE.cursor];
  };
  await refreshCursor();
  const cursorTimer = setInterval(() => void refreshCursor().catch(() => undefined), 1000);
  cursorTimer.unref();

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
    clearInterval(cursorTimer);
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
