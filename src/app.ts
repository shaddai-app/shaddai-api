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
import { accountDataRouter } from './modules/account/account-data.routes.js';
import { accountRouter } from './modules/account/account.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { meRouter } from './modules/me/me.routes.js';
import { platformRoutes } from './modules/platform/platform.routes.js';
import { rolesRouter } from './modules/roles/roles.routes.js';
import { cellsRouter } from './modules/cells/cells.routes.js';
import { cellReportsRouter } from './modules/cells/reports.routes.js';
import { cellStructureRouter } from './modules/cells/structure.routes.js';
import { consolidationRouter } from './modules/consolidation/consolidation.routes.js';
import { calendarRouter } from './modules/calendar/calendar.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { ministriesRouter } from './modules/ministries/ministries.routes.js';
import { worshipRouter } from './modules/worship/worship.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { financeRouter } from './modules/finance/finance.routes.js';
import { financeReportsRouter } from './modules/finance/reports/reports.routes.js';
import { householdsRouter } from './modules/people/households.routes.js';
import { newcomersRouter } from './modules/people/newcomers.routes.js';
import { peopleIoRouter } from './modules/people/people.io.routes.js';
import { peopleRouter } from './modules/people/people.routes.js';
import { publicRouter } from './modules/public/public.routes.js';
import { searchRouter } from './modules/search/search.routes.js';
import { campusRouter } from './modules/structure/campus.routes.js';
import { catalogsRouter } from './modules/structure/catalogs.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

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
  api.use(publicRouter); // sin sesión, con sus propios límites
  api.use(apiLimiter);
  api.use(authRouter);
  api.use(meRouter);
  api.use(campusRouter);
  api.use(catalogsRouter);
  api.use(peopleIoRouter); // antes de peopleRouter: /people/export no es /people/:id
  api.use(peopleRouter);
  api.use(householdsRouter);
  api.use(newcomersRouter);
  api.use(searchRouter);
  api.use(cellStructureRouter);
  api.use(cellReportsRouter); // antes de cellsRouter: /cells/genealogy no es /cells/:id
  api.use(cellsRouter);
  api.use(consolidationRouter);
  api.use(financeRouter);
  api.use(financeReportsRouter);
  api.use(calendarRouter);
  api.use(dashboardRouter);
  api.use(ministriesRouter);
  api.use(worshipRouter);
  api.use(inventoryRouter);
  api.use(notificationsRouter);
  api.use(usersRouter);
  api.use(rolesRouter);
  api.use(accountRouter);
  api.use(accountDataRouter);
  api.use(platformRoutes);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
