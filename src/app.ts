import express from 'express';
import cors from 'cors';
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
import { AppEnv } from './config/env';
import { networkMiddleware } from './middleware/network';

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

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(securityHeaders);
  app.use(cors({ origin: corsOrigin(env) }));
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));
  const defaultNetworkPassphrase = env.API_NETWORK_DEFAULT || env.STELLAR_NETWORK_PASSPHRASE;
  app.use(networkMiddleware(defaultNetworkPassphrase));

  app.get('/', (_req, res) => {
    res.json({
      name: 'D-Indexer-Backend',
      status: 'ok',
      docs: '/health',
    });
  });

  app.use('/testnet/folders', folderRoutes);
  app.use('/testnet/templates', templateRoutes);
  app.use('/testnet/portfolios', portfolioRoutes);
  app.use('/testnet/upload', uploadRoutes);
  app.use('/testnet/health', healthRoutes);

  app.use('/folders', folderRoutes);
  app.use('/templates', templateRoutes);
  app.use('/portfolios', portfolioRoutes);
  app.use('/upload', uploadRoutes);
  app.use('/health', healthRoutes);

  app.use(notFoundHandler);
  app.use(multerErrorHandler);
  app.use(errorHandler);

  return app;
}
