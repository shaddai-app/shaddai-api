import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../http/errors.js';

const allowedOrigins = new Set([...env.CORS_ORIGINS, new URL(env.APP_URL).origin]);

/**
 * Defensa CSRF para endpoints que actúan con la cookie de refresh (además de SameSite=Strict):
 * exige un header custom (un form cross-site no puede enviarlo) y, si viene Origin, que sea conocido.
 */
export const requireSameSiteRequest: RequestHandler = (req, _res, next) => {
  if (req.get('x-requested-with') !== 'shaddai') throw AppError.forbidden('CSRF_HEADER_MISSING');
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) throw AppError.forbidden('CSRF_ORIGIN_REJECTED');
  next();
};
