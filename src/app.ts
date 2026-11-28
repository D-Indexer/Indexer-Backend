import express, { RequestHandler } from 'express';
import cors from 'cors';
import { createFolderRoutes } from './routes/folder.routes';
import { createTemplateRoutes } from './routes/template.routes';
import { createCreatorRoutes } from './routes/creator.routes';
import { createUploadRoutes } from './routes/upload.routes';
import { createPortfolioRoutes } from './routes/portfolio.routes';
import { createHealthRoutes } from './routes/health.routes';
import { errorHandler } from './middleware/errorHandler';
import { multerErrorHandler } from './middleware/multerErrorHandler';
import { notFoundHandler } from './middleware/notFound';
import { requestId } from './middleware/requestId';
import { securityHeaders } from './middleware/securityHeaders';
import { AppEnv } from './config/env';
import type { FeatureFlagKey, FeatureFlagService } from './featureFlags';
import type { Queryable } from './db/types';

/**
 * Dependencies required to build the HTTP app. Everything is passed in
 * explicitly so this module can be imported without touching `process.env`
 * or opening any I/O.
 */
export interface AppDependencies {
  env: AppEnv;
  db: unknown;
  services: Record<string, unknown>;
  featureFlags: FeatureFlagService;
}

/** Feature flag gating each gated route group. */
const ROUTE_FLAGS: Record<string, FeatureFlagKey> = {
  uploads: 'uploads',
  bundles: 'bundle_uploads',
  webhooks: 'webhooks',
  sse: 'sse',
  graphql: 'graphql',
};

/**
 * Builds middleware that rejects requests with 503 when the given feature flag
 * is disabled. The flag is evaluated per request (the service caches reads).
 */
export function requireFeature(featureFlags: FeatureFlagService, flag: FeatureFlagKey): RequestHandler {
  return (_req, res, next) => {
    featureFlags
      .isEnabled(flag)
      .then((enabled) => {
        if (enabled) {
          next();
          return;
        }
        res.status(503).json({
          error: 'Service Unavailable',
          message: `The '${flag}' feature is currently disabled.`,
          feature: flag,
        });
      })
      .catch(next);
  };
}

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

export function createApp(deps: AppDependencies) {
  const { env, featureFlags } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(securityHeaders);
  app.use(cors({ origin: corsOrigin(env) }));
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));

  app.get('/', (_req, res) => {
    res.json({
      name: 'D-Indexer-Backend',
      status: 'ok',
      docs: '/health',
    });
  });

  app.use('/folders', createFolderRoutes(deps));
  // Read-model routes query the database directly through an explicit handle.
  const db = deps.db as Queryable;
  app.use('/templates', createTemplateRoutes({ db }));
  app.use('/creators', createCreatorRoutes({ db }));
  app.use('/portfolios', createPortfolioRoutes(deps));
  app.use('/upload', requireFeature(featureFlags, ROUTE_FLAGS.uploads), createUploadRoutes(deps));
  app.use('/health', createHealthRoutes(deps));

  app.use(notFoundHandler);
  app.use(multerErrorHandler);
  app.use(errorHandler);

  return app;
}
