import { rateLimit, type Options } from 'express-rate-limit';
import { env, rateLimitStore } from '../../config/env.js';
import { DbRateLimitStore } from '../db/rate-limit-store.js';

// Con una sola instancia alcanza el store en memoria; con varias (producción) se cuenta en la base,
// así el límite es por IP y no por IP e instancia. Cada limitador tiene su propio prefijo.
function limiter(name: string, windowMs: number, limit: number, overrides: Partial<Options> = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    store: rateLimitStore === 'db' ? new DbRateLimitStore(name) : undefined,
    // Si la base no responde, se deja pasar: el límite protege, pero no debe tirar la API.
    passOnStoreError: true,
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({ error: { code: 'RATE_LIMITED' } });
    },
    ...overrides,
  });
}

/** Login y verificación 2FA: 10 intentos por minuto por IP (el bloqueo por usuario va aparte). */
export const loginLimiter = limiter('login', 60_000, 10);

/**
 * Ingreso a la demo con un clic: más holgado que el login porque en una presentación entran muchos
 * desde la misma red, y no hay contraseña que adivinar.
 */
export const demoLoginLimiter = limiter('demo-login', 60_000, 20);

/** Olvidé / reset de contraseña: 5 cada 15 minutos por IP. */
export const passwordResetLimiter = limiter('password', 15 * 60_000, 5);

/** Refresh: holgado (varias pestañas), pero corta abusos. */
export const refreshLimiter = limiter('refresh', 60_000, 60);

/** Formularios públicos (Soy nuevo): 5 envíos cada 10 minutos por IP. */
export const publicFormLimiter = limiter('public-form', 10 * 60_000, 5);

/** Lecturas públicas (configuración del formulario, logo). */
export const publicReadLimiter = limiter('public-read', 60_000, 60);

/** Exportación completa de la iglesia (pesada): 3 por hora. */
export const exportLimiter = limiter('export', 60 * 60_000, 3);

/** Resto de la API autenticada. */
export const apiLimiter = limiter('api', 60_000, 300);
