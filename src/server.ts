import 'dotenv/config';
import { createApp } from './app';
import { getEnv } from './config/env';
import pool from './db/client';
import { startIndexer } from './indexer/stellar';
import { logger } from './utils/logger';

const env = getEnv();
const app = createApp(env);
const indexer = startIndexer();

const server = app.listen(env.PORT, () => {
  logger.info('Server started', { port: env.PORT, nodeEnv: env.NODE_ENV });
});

async function shutdown(signal: string): Promise<void> {
  logger.info('Shutdown requested', { signal });
  indexer.stop();

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

    await pool.end();
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
