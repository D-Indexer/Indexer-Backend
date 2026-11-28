import 'dotenv/config';
import { createApp } from './app';
import { createContainer } from './container';
import { logger } from './utils/logger';

/**
 * API process entrypoint.
 *
 * This is one of the only modules allowed to read environment variables and
 * start I/O. Everything else receives its dependencies explicitly from the
 * composition root (`src/container.ts`). The indexer runs separately: see
 * `src/indexer/main.ts`.
 */
const container = createContainer();
const { env, pool } = container;
const app = createApp(container.deps);

const server = app.listen(env.PORT, () => {
  logger.info('Server started', { port: env.PORT, nodeEnv: env.NODE_ENV });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.info('Shutdown already in progress', { signal });
    return;
  }
  shuttingDown = true;

  logger.info('Shutdown requested', { signal });

  const timeout = setTimeout(() => {
    logger.error('Shutdown timed out', { timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  server.close(async (err) => {
    if (err) {
      logger.error('HTTP server close failed', { error: err.message });
      clearTimeout(timeout);
      process.exit(1);
    }

    try {
      await pool.end();
    } catch (poolErr) {
      logger.error('Pool shutdown failed', {
        error: poolErr instanceof Error ? poolErr.message : String(poolErr),
      });
      clearTimeout(timeout);
      process.exit(1);
    }

    clearTimeout(timeout);
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message });
  void shutdown('uncaughtException');
});

export default app;