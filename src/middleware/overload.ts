/**
 * #188 – Event-loop-lag-based load shedding and per-route deadline middleware.
 *
 * createOverloadMiddleware:
 *   Measures event-loop delay with perf_hooks.monitorEventLoopDelay (1 s
 *   resolution). When the p99 lag exceeds OVERLOAD_LAG_THRESHOLD_MS, every
 *   request except GET /health/* is rejected with 503 + Retry-After.
 *
 * withDeadline(timeoutMs):
 *   Returns a middleware that aborts the request handler after timeoutMs.
 *   Sets res.headersSent guard so a timed-out response is never double-sent.
 *   The AbortSignal on req.abortSignal lets downstream fetch/DB calls cancel.
 */
import { Request, Response, NextFunction } from 'express';
import { monitorEventLoopDelay } from 'perf_hooks';
import { AppEnv } from '../config/env';

// Augment Express Request so handlers can read the abort signal.
declare global {
  namespace Express {
    interface Request {
      abortSignal?: AbortSignal;
    }
  }
}

export interface OverloadMonitor {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  stop: () => void;
}

export function createOverloadMiddleware(
  env: Pick<AppEnv, 'OVERLOAD_LAG_THRESHOLD_MS' | 'OVERLOAD_RETRY_AFTER_S'>
): OverloadMonitor {
  const histogram = monitorEventLoopDelay({ resolution: 1000 });
  histogram.enable();

  function middleware(req: Request, res: Response, next: NextFunction): void {
    // Always let liveness / readiness probes through.
    if (req.path.startsWith('/health')) {
      next();
      return;
    }

    // perf_hooks reports in nanoseconds; convert to ms.
    const p99Ms = histogram.percentile(99) / 1e6;

    if (p99Ms > env.OVERLOAD_LAG_THRESHOLD_MS) {
      res.set('Retry-After', String(env.OVERLOAD_RETRY_AFTER_S));
      res.status(503).json({
        error: 'Server temporarily overloaded — high event-loop lag. Please retry shortly.',
        retryAfterSeconds: env.OVERLOAD_RETRY_AFTER_S,
      });
      return;
    }

    next();
  }

  function stop(): void {
    histogram.disable();
  }

  return { middleware, stop };
}

/**
 * Per-route deadline middleware.
 *
 * Sends 503 (read routes) or 504 (upload routes) and sets req.abortSignal so
 * downstream work can cancel when the client waits too long.
 */
export function withDeadline(timeoutMs: number, statusOnTimeout: 503 | 504 = 503) {
  return function deadlineMiddleware(req: Request, res: Response, next: NextFunction): void {
    const ac = new AbortController();
    req.abortSignal = ac.signal;

    const timer = setTimeout(() => {
      ac.abort();
      if (!res.headersSent) {
        res.status(statusOnTimeout).json({
          error:
            statusOnTimeout === 504
              ? 'Gateway timeout — upstream took too long.'
              : 'Request deadline exceeded.',
        });
      }
    }, timeoutMs);

    // Clean up the timer whether the response finishes normally or via timeout.
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}
