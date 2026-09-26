import { rateLimit, type Options } from 'express-rate-limit';
import { env } from '../../config/env.js';

// Store en memoria: suficiente con una instancia. Con varias (Fase 8) pasa a store compartido.
function limiter(windowMs: number, limit: number, overrides: Partial<Options> = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({ error: { code: 'RATE_LIMITED' } });
    },
    ...overrides,
  });
}

/** Login y verificación 2FA: 10 intentos por minuto por IP (el bloqueo por usuario va aparte). */
export const loginLimiter = limiter(60_000, 10);

/** Olvidé / reset de contraseña: 5 cada 15 minutos por IP. */
export const passwordResetLimiter = limiter(15 * 60_000, 5);

/** Refresh: holgado (varias pestañas), pero corta abusos. */
export const refreshLimiter = limiter(60_000, 60);

/** Resto de la API autenticada. */
export const apiLimiter = limiter(60_000, 300);
