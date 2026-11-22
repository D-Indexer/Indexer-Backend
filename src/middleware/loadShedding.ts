/**
 * #187 – DB pool load-shedding middleware.
 *
 * Rejects new requests with 503 + Retry-After when the pool's waitingCount
 * exceeds DB_POOL_SHED_THRESHOLD, giving callers an explicit back-pressure
 * signal instead of a 5-second hang followed by a generic 500.
 *
 * Usage: mount before any route that makes DB calls.
 *   app.use(dbLoadShedding(pool, env));
 */
import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { AppEnv } from '../config/env';

export function dbLoadShedding(
  pool: Pool,
  env: Pick<AppEnv, 'DB_POOL_SHED_THRESHOLD' | 'DB_POOL_RETRY_AFTER_S'>
) {
  return function dbLoadSheddingMiddleware(_req: Request, res: Response, next: NextFunction): void {
    const { waitingCount } = pool;
    if (waitingCount > env.DB_POOL_SHED_THRESHOLD) {
      res.set('Retry-After', String(env.DB_POOL_RETRY_AFTER_S));
      res.status(503).json({
        error: 'Service temporarily overloaded — database pool saturated. Please retry shortly.',
        retryAfterSeconds: env.DB_POOL_RETRY_AFTER_S,
      });
      return;
    }
    next();
  };
}
