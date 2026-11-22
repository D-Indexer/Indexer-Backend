import 'dotenv/config';
import { createApp } from './app';
import { getEnv } from './config/env';
import pool from './db/client';
import { logger } from './utils/logger';

/** API process entrypoint. The indexer runs separately: see src/indexer/main.ts. */
const env = getEnv();
const app = createApp(env);

const server = app.listen(env.PORT, () => {
  logger.info('Server started', { port: env.PORT, nodeEnv: env.NODE_ENV });
});

// #190 – Harden against slow-header / slow-body clients and LB keep-alive mismatch.
// headersTimeout: abort connections that don't complete headers in time (slowloris defence).
// requestTimeout: abort stalled upload bodies and release their buffers.
// keepAliveTimeout: must exceed the upstream LB idle timeout to avoid 502s on reused sockets.
//   Common LB defaults: AWS ALB 60 s, GCP/Nginx 75 s. Default here is 65 s, raise if needed.
// maxRequestsPerSocket: 0 = unlimited (Node default); set > 0 to cap requests per connection.
server.headersTimeout = env.SERVER_HEADERS_TIMEOUT_MS;
server.requestTimeout = env.SERVER_REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = env.SERVER_KEEP_ALIVE_TIMEOUT_MS;
server.maxRequestsPerSocket = env.SERVER_MAX_REQUESTS_PER_SOCKET;

logger.info('HTTP server timeouts configured', {
  headersTimeoutMs: env.SERVER_HEADERS_TIMEOUT_MS,
  requestTimeoutMs: env.SERVER_REQUEST_TIMEOUT_MS,
  keepAliveTimeoutMs: env.SERVER_KEEP_ALIVE_TIMEOUT_MS,
  maxRequestsPerSocket: env.SERVER_MAX_REQUESTS_PER_SOCKET,
});

async function shutdown(signal: string): Promise<void> {
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
