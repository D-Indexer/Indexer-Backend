import type { Logger } from './logger.js';

export interface ProcessHandlersOptions {
  logger: Logger;
  shutdown: (reason: string) => Promise<void> | void;
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function formatError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

async function runShutdown(
  shutdown: (reason: string) => Promise<void> | void,
  reason: string,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.error(
        { reason, timeoutMs: SHUTDOWN_TIMEOUT_MS },
        'Graceful shutdown timed out; forcing exit',
      );
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  try {
    await Promise.race([Promise.resolve(shutdown(reason)), timeout]);
  } catch (err) {
    const { message, stack } = formatError(err);
    logger.error({ reason, err: message, stack }, 'Error during graceful shutdown');
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function installProcessHandlers({ logger, shutdown }: ProcessHandlersOptions): void {
  process.on('uncaughtException', (err: Error) => {
    const { message, stack } = formatError(err);
    logger.error({ err: message, stack }, 'Uncaught exception; shutting down');
    void runShutdown(shutdown, 'uncaughtException', logger).finally(() => {
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const { message, stack } = formatError(reason);
    if (isProduction()) {
      logger.error({ err: message, stack }, 'Unhandled rejection; shutting down');
      void runShutdown(shutdown, 'unhandledRejection', logger).finally(() => {
        process.exit(1);
      });
    } else {
      logger.error({ err: message, stack }, 'Unhandled rejection (non-fatal in development)');
    }
  });
}

export function logStartupFailure(logger: Logger, err: unknown, context?: Record<string, unknown>): void {
  const { message, stack } = formatError(err);
  logger.error({ ...context, err: message, stack }, 'Startup failure');
}
```

Note: the `Logger` import path assumes `src/utils/logger.ts` exports a `Logger` type. If the existing logger module uses a different name or path, adjust the import accordingly.