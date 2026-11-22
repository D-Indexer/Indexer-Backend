import { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http/errors';
import { logger } from '../utils/logger';

/** pg pool exhaustion surfaces as an Error with this message prefix. */
const POOL_TIMEOUT_MSG = 'timeout exceeded when trying to connect';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // #187 – Map pg pool acquisition timeouts to 503 instead of 500.
  const isPoolTimeout = err instanceof Error && err.message.toLowerCase().includes(POOL_TIMEOUT_MSG);

  const statusCode = isPoolTimeout ? 503 : err instanceof HttpError ? err.statusCode : 500;
  const expose = isPoolTimeout ? true : err instanceof HttpError ? err.expose : false;
  const message = isPoolTimeout
    ? 'Service temporarily overloaded — database pool exhausted. Please retry shortly.'
    : expose && err instanceof Error
      ? err.message
      : 'Internal server error';

  logger.error('Request failed', {
    statusCode,
    requestId: _req.id,
    method: _req.method,
    path: _req.originalUrl,
    error: err instanceof Error ? err.message : err,
  });

  if (isPoolTimeout) {
    res.set('Retry-After', '5');
  }

  res.status(statusCode).json({
    error: message,
    requestId: _req.id,
  });
}
