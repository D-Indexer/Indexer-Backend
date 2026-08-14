import { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http/errors';
import { logger } from '../utils/logger';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const statusCode = err instanceof HttpError ? err.statusCode : 500;
  const expose = err instanceof HttpError ? err.expose : false;
  const message = expose && err instanceof Error ? err.message : 'Internal server error';

  logger.error('Request failed', {
    statusCode,
    requestId: _req.id,
    method: _req.method,
    path: _req.originalUrl,
    error: err instanceof Error ? err.message : err,
  });

  res.status(statusCode).json({
    error: message,
    requestId: _req.id,
  });
}
