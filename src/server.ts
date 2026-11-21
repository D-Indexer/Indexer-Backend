import 'dotenv/config';
import type { ServerResponse } from 'node:http';
import { createApp } from './app';
import { getEnv } from './config/env';
import pool from './db/client';
import { logger } from './utils/logger';
import { isShuttingDown, markShuttingDown } from './shutdown';

/** API process entrypoint. The indexer runs separately: see src/indexer/main.ts. */
const env = getEnv();
const app = createApp(env);

/** In-flight responses, so shutdown can mark them `Connection: close`. */
const inFlight = new Set<ServerResponse>();

app.use((_req, res, next) => {
  if (isShuttingDown()) {
    res.setHeader('Connection', 'close');
    res.setHeader('Retry-After', '1');
  }
  inFlight.add(res);
  res.on('close', () => inFlight.delete(res));
  next();
});

const server = app.listen(env.PORT, () => {
  logger.info('Server started', { port: env.PORT, nodeEnv: env.NODE_ENV });
});

/** Idle keep-alive sockets are closed immediately; busy ones finish their response. */
function closeIdleConnections(): void {
  server.closeIdleConnections();
}

function closeAllConnections(): void {
  server.closeAllConnections();
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown()) return;
  markShuttingDown();
  logger.info('Shutdown requested', { signal });

  const timeout = setTimeout(() => {
    logger.error('Shutdown timed out', { timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  // Force-close whatever is still open before the hard timeout.
  const forceClose = setTimeout(() => {
    logger.warn('Force-closing remaining connections', { forceCloseMs: env.SHUTDOWN_FORCE_CLOSE_MS });
    closeAllConnections();
  }, env.SHUTDOWN_FORCE_CLOSE_MS);
  forceClose.unref();

  // Ask in-flight responses to close their connection once they finish.
  for (const res of inFlight) {
    if (!res.headersSent) res.setHeader('Connection', 'close');
  }

  // Stop accepting new connections and close idle keep-alive sockets.
  closeIdleConnections();

  server.close(async (err) => {
    clearTimeout(forceClose);
    if (err) {
      logger.error('HTTP server close failed', { error: err.message });
      clearTimeout(timeout);
      process.exit(1);
    }

    // Only end the pool once the HTTP server has fully closed.
    try {
      await pool.end();
    } catch (poolErr) {
      logger.error('Database pool close failed', {
        error: poolErr instanceof Error ? poolErr.message : String(poolErr),
      });
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
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});

export default app;
