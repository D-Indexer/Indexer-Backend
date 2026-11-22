import express from 'express';
import cors from 'cors';
import pool from './db/client';
import folderRoutes from './routes/folder.routes';
import templateRoutes from './routes/template.routes';
import uploadRoutes from './routes/upload.routes';
import portfolioRoutes from './routes/portfolio.routes';
import healthRoutes from './routes/health.routes';
import { errorHandler } from './middleware/errorHandler';
import { multerErrorHandler } from './middleware/multerErrorHandler';
import { notFoundHandler } from './middleware/notFound';
import { requestId } from './middleware/requestId';
import { securityHeaders } from './middleware/securityHeaders';
import { dbLoadShedding } from './middleware/loadShedding';
import { createOverloadMiddleware, withDeadline } from './middleware/overload';
import { AppEnv } from './config/env';

/**
 * CORS_ORIGIN: comma-separated allow-list, or `*` for any origin. Unset allows
 * any origin outside production; production requires it (see config/env.ts).
 */
export function corsOrigin(env: Pick<AppEnv, 'CORS_ORIGIN'>): cors.CorsOptions['origin'] {
  if (!env.CORS_ORIGIN || env.CORS_ORIGIN.trim() === '*') return true;

  const allowed = env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowed.length === 0) return false;
  return allowed;
}

export function createApp(env: AppEnv) {
  const app = express();

  const { middleware: overloadMiddleware } = createOverloadMiddleware(env);

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(securityHeaders);
  app.use(cors({ origin: corsOrigin(env) }));
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));

  // #188 – Shed load when event-loop lag is high (health probes are exempt).
  app.use(overloadMiddleware);

  // #187 – Shed load when the DB pool is saturated.
  app.use(dbLoadShedding(pool, env));

  app.get('/', (_req, res) => {
    res.json({
      name: 'D-Indexer-Backend',
      status: 'ok',
      docs: '/health',
    });
  });

  // #188 – Per-route deadlines: 5 s for reads, 60 s for uploads.
  app.use('/folders', withDeadline(env.ROUTE_TIMEOUT_READ_MS), folderRoutes);
  app.use('/templates', withDeadline(env.ROUTE_TIMEOUT_READ_MS), templateRoutes);
  app.use('/portfolios', withDeadline(env.ROUTE_TIMEOUT_READ_MS), portfolioRoutes);
  app.use('/upload', withDeadline(env.ROUTE_TIMEOUT_UPLOAD_MS, 504), uploadRoutes);
  app.use('/health', healthRoutes);

  app.use(notFoundHandler);
  app.use(multerErrorHandler);
  app.use(errorHandler);

  return app;
}
