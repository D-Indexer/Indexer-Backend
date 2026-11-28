import { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http/errors';
import { logger } from '../utils/logger';
import { errorReporter } from '../utils/errorReporter';

function getRouteTemplate(req: Request): string | undefined {
  const routePath = (req as Request & { route?: { path?: string } }).route?.path;
  if (typeof routePath === 'string' && routePath.length > 0) {
    return routePath;
  }
  // Fall back to a normalized path: strip query string and replace
  // numeric/hex/uuid-like segments with placeholders so raw URLs are not sent.
  const rawPath = (req.originalUrl || req.url || '').split('?')[0];
  if (!rawPath) {
    return undefined;
  }
  return rawPath
    .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-fA-F]{16,}(?=\/|$)/g, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

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

  const isUnexpected = !(err instanceof HttpError) || statusCode >= 500;
  if (isUnexpected) {
    try {
      errorReporter.captureException(err, {
        requestId: _req.id,
        method: _req.method,
        route: getRouteTemplate(_req),
        statusCode,
      });
    } catch (reportErr) {
      logger.warn('Failed to report error', {
        requestId: _req.id,
        error: reportErr instanceof Error ? reportErr.message : reportErr,
      });
    }
  }

  res.status(statusCode).json({
    error: message,
    ...(err instanceof HttpError && err.details !== undefined ? { details: err.details } : {}),
    requestId: _req.id,
  });
}