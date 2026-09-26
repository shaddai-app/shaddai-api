import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { contextMiddleware } from './core/context.js';
import { errorHandler, notFoundHandler } from './core/middleware/error-handler.js';
import { apiLimiter } from './core/middleware/rate-limit.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { meRouter } from './modules/me/me.routes.js';
import { platformRoutes } from './modules/platform/platform.routes.js';
import { campusRouter } from './modules/structure/campus.routes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Columnas BigInt (ej. AuditLog.id) no son serializables por JSON.stringify.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        // Solo se acepta un id entrante con forma de UUID (evita inyectar basura en los logs).
        const id = typeof incoming === 'string' && UUID_RE.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(contextMiddleware);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store'); // respuestas con datos personales/tokens: nunca cachear
    next();
  });
  api.use(healthRouter);
  api.use(apiLimiter);
  api.use(authRouter);
  api.use(meRouter);
  api.use(campusRouter);
  api.use(platformRoutes);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
