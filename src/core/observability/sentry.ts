import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent } from '@sentry/node';
import { env } from '../../config/env.js';
import { getContext } from '../context.js';

// Errores no previstos a Sentry, solo si hay SENTRY_DSN. Sin datos personales: ni cuerpos, ni cookies,
// ni headers, ni parámetros de URL (pueden traer tokens, búsquedas por nombre o claves de terceros).
// Para ubicar el caso alcanzan el requestId (que también está en el log) y los ids de cuenta y usuario.

/** Saca el query string y el fragmento de una URL. */
export function stripQuery(url: string): string {
  return url.split(/[?#]/)[0]!;
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: event.request.url ? stripQuery(event.request.url) : undefined,
    };
  }
  if (event.user) event.user = event.user.id === undefined ? undefined : { id: event.user.id };
  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  if (crumb.data && typeof crumb.data.url === 'string') {
    crumb.data = { ...crumb.data, url: stripQuery(crumb.data.url) };
  }
  return crumb;
}

let enabled = false;

export function initSentry(): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0, // solo errores; el rendimiento se mide aparte
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  enabled = true;
}

/** Reporta un error inesperado con el contexto del pedido o proceso en curso. */
export function reportError(err: unknown, extra: Record<string, string | number | undefined> = {}): void {
  if (!enabled) return;
  const ctx = getContext();
  Sentry.withScope((scope) => {
    if (ctx?.requestId) scope.setTag('requestId', ctx.requestId);
    if (ctx?.accountId) scope.setTag('accountId', String(ctx.accountId));
    if (ctx?.userId) scope.setUser({ id: String(ctx.userId) });
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) scope.setTag(key, String(value));
    }
    Sentry.captureException(err);
  });
}

/** Envía lo pendiente antes de cerrar el proceso. */
export async function flushSentry(): Promise<void> {
  if (enabled) await Sentry.close(2_000);
}
