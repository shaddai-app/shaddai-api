import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

/** Datos de la request disponibles en cualquier capa (auditoría, logs, tenant). */
export interface RequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  userId?: number;
  accountId?: number | null;
  impersonatorId?: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export const contextMiddleware: RequestHandler = (req, _res, next) => {
  storage.run(
    {
      requestId: String(req.id),
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 300),
    },
    next,
  );
};

/** Corre fn con un contexto armado a mano (scripts como el seed, que no pasan por una request). */
export const runInContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);
