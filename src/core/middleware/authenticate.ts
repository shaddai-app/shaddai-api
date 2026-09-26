import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../auth/jwt.js';
import { getContext } from '../context.js';
import { prisma } from '../db/prisma.js';
import { AppError } from '../http/errors.js';
import type { PermissionMap } from '../rbac/resolve.js';
import {
  assertCanHoldSession,
  isAccountReadOnly,
  isFamilyActive,
  passwordVersion,
  restrictionFor,
  sessionUserSelect,
  type SessionRestriction,
} from '../../modules/auth/session.service.js';

export interface AuthContext {
  userId: number;
  accountId: number | null;
  isPlatformAdmin: boolean;
  sessionId: string;
  restriction: SessionRestriction;
  accountReadOnly: boolean;
  /** Se completa en requirePermission (cacheado). */
  permissions?: PermissionMap;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const RESTRICTION_ERRORS: Record<Exclude<SessionRestriction, null>, string> = {
  password_change: 'PASSWORD_CHANGE_REQUIRED',
  totp_enroll: 'TOTP_ENROLLMENT_REQUIRED',
};

/**
 * Valida el access token contra el estado actual en la DB (usuario activo, cuenta no suspendida,
 * contraseña no cambiada, sesión no revocada). La restricción se recalcula siempre desde la DB.
 * `allowRestricted`: solo para los endpoints que completan el paso pendiente (cambio de pass, 2FA, /me).
 */
export function authenticate(options: { allowRestricted?: boolean } = {}): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw AppError.unauthorized('AUTH_REQUIRED');

    const claims = await verifyAccessToken(token);
    if (!claims) throw AppError.unauthorized('AUTH_TOKEN_INVALID');

    const user = await prisma.user.findUnique({
      where: { id: Number(claims.sub) },
      select: sessionUserSelect,
    });
    if (!user) throw AppError.unauthorized('AUTH_TOKEN_INVALID');
    assertCanHoldSession(user);
    if (claims.ver !== passwordVersion(user)) throw AppError.unauthorized('AUTH_SESSION_REVOKED');
    if (!(await isFamilyActive(claims.sid))) throw AppError.unauthorized('AUTH_SESSION_REVOKED');

    const restriction = restrictionFor(user);
    if (restriction && !options.allowRestricted) throw AppError.forbidden(RESTRICTION_ERRORS[restriction]);

    req.auth = {
      userId: user.id,
      accountId: user.accountId,
      isPlatformAdmin: user.isPlatformAdmin,
      sessionId: claims.sid,
      restriction,
      accountReadOnly: isAccountReadOnly(user.account),
    };
    const ctx = getContext();
    if (ctx) {
      ctx.userId = user.id;
      ctx.accountId = user.accountId;
    }
    next();
  };
}

/** Acceso a req.auth en handlers que ya pasaron por authenticate(). */
export function authOf(req: { auth?: AuthContext }): AuthContext {
  if (!req.auth) throw AppError.unauthorized('AUTH_REQUIRED');
  return req.auth;
}
