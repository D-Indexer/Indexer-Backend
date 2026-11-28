import express, { RequestHandler } from 'express';
import cors from 'cors';
import { createFolderRoutes } from './routes/folder.routes';
import { createTemplateRoutes } from './routes/template.routes';
import { createCreatorRoutes } from './routes/creator.routes';
import { createStatsRoutes } from './routes/stats.routes';
import { createApiKeyAuth } from './middleware/apiKey';
import { logger } from './utils/logger';
import { createUploadRoutes } from './routes/upload.routes';
import { createPortfolioRoutes } from './routes/portfolio.routes';
import { createHealthRoutes } from './routes/health.routes';
import { errorHandler } from './middleware/errorHandler';
import { multerErrorHandler } from './middleware/multerErrorHandler';
import { notFoundHandler } from './middleware/notFound';
import { requestId } from './middleware/requestId';
import { readConsistency } from './middleware/readConsistency';
import { securityHeaders } from './middleware/securityHeaders';
import { noStore } from './middleware/conditionalGet';
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

  const { middleware: overloadMiddleware } = createOverloadMiddleware(env);

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  warnIfTrustProxyUnset(env);
  app.use(requestId);
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info('Request', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ip: req.ip,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });
  app.use(securityHeaders);
  app.use(cors({ origin: corsOrigin(env) }));
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));
  const defaultNetworkPassphrase = env.API_NETWORK_DEFAULT || env.STELLAR_NETWORK_PASSPHRASE;
  app.use(networkMiddleware(defaultNetworkPassphrase));

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

  // Read-model routes query the database directly through an explicit handle.
  const db = deps.db as Queryable;

  // Optional API keys on read endpoints: anonymous requests keep working, a
  // valid key attributes and counts usage, an invalid one gets 401. Disabled
  // when API_KEY_HMAC_SECRET is unset.
  const apiKeyAuth = env.API_KEY_HMAC_SECRET
    ? createApiKeyAuth({
        db,
        secret: env.API_KEY_HMAC_SECRET,
        onFlushError: (err) =>
          logger.warn('API key usage flush failed; will retry', {
            error: err instanceof Error ? err.message : String(err),
          }),
      })
    : null;
  // Exposed so the server can flush pending usage on shutdown.
  app.locals['apiKeyAuth'] = apiKeyAuth;
  const read: RequestHandler[] = apiKeyAuth ? [apiKeyAuth.middleware] : [];

  app.use('/folders', ...read, createFolderRoutes(deps));
  app.use('/templates', ...read, createTemplateRoutes({ db }));
  app.use('/creators', ...read, createCreatorRoutes({ db }));
  app.use('/stats', ...read, createStatsRoutes({ db }));
  app.use('/portfolios', ...read, createPortfolioRoutes(deps));
  app.use('/upload', requireFeature(featureFlags, ROUTE_FLAGS.uploads), createUploadRoutes(deps));
  app.use('/health', createHealthRoutes(deps));

  app.use(notFoundHandler);
  app.use(multerErrorHandler);
  app.use(errorHandler);

  return app;
}
