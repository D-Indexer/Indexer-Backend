import express from 'express';
import cors from 'cors';
import folderRoutes from './routes/folder.routes';
import templateRoutes from './routes/template.routes';
import uploadRoutes from './routes/upload.routes';
import healthRoutes from './routes/health.routes';
import { errorHandler } from './middleware/errorHandler';
import { multerErrorHandler } from './middleware/multerErrorHandler';
import { notFoundHandler } from './middleware/notFound';
import { requestId } from './middleware/requestId';
import { securityHeaders } from './middleware/securityHeaders';
import { AppEnv } from './config/env';

function corsOrigin(env: AppEnv): cors.CorsOptions['origin'] {
  if (!env.CORS_ORIGIN) return true;

  const allowed = env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowed.length === 0) return true;
  return allowed;
}

export function createApp(env: AppEnv) {
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

  app.use('/folders', folderRoutes);
  app.use('/templates', templateRoutes);
  app.use('/upload', uploadRoutes);
  app.use('/health', healthRoutes);

  app.use(notFoundHandler);
  app.use(multerErrorHandler);
  app.use(errorHandler);

  return app;
}
