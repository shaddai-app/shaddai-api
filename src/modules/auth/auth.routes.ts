import { Router, type Response } from 'express';
import { isProd } from '../../config/env.js';
import { audit } from '../../core/audit/audit.js';
import { hashToken } from '../../core/auth/tokens.js';
import { forbidForDemoUsers } from '../../core/demo.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';
import { parse } from '../../core/http/validate.js';
import { authenticate, authOf, forbidImpersonation } from '../../core/middleware/authenticate.js';
import { requireSameSiteRequest } from '../../core/middleware/csrf.js';
import { loginLimiter, passwordResetLimiter, refreshLimiter } from '../../core/middleware/rate-limit.js';
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RecoveryCodesSchema,
  ResetPasswordSchema,
  TotpConfirmSchema,
  TotpDisableSchema,
  TwoFactorVerifySchema,
} from './auth.schemas.js';
import { stopImpersonation } from '../platform/impersonation.service.js';
import * as auth from './auth.service.js';
import {
  revokeAllSessions,
  revokeFamily,
  rotateRefreshToken,
  type IssuedSession,
} from './session.service.js';

export const REFRESH_COOKIE = 'sh_rt';
const COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(res: Response, session: IssuedSession) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: session.refreshExpiresAt,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: isProd, sameSite: 'strict', path: COOKIE_PATH });
}

/** El refresh token viaja solo en la cookie httpOnly; al front le llega el access token. */
function sessionResponse(res: Response, session: IssuedSession) {
  setRefreshCookie(res, session);
  res.json({ accessToken: session.accessToken, restriction: session.restriction });
}

export const authRouter = Router();

authRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const result = await auth.login(parse(LoginSchema, req.body));
  if (result.requires2fa) {
    res.json({ requires2fa: true, challengeToken: result.challengeToken });
    return;
  }
  sessionResponse(res, result);
});

authRouter.post('/auth/2fa/verify', loginLimiter, async (req, res) => {
  sessionResponse(res, await auth.verifyTwoFactor(parse(TwoFactorVerifySchema, req.body)));
});

authRouter.post('/auth/refresh', refreshLimiter, requireSameSiteRequest, async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!raw) throw AppError.unauthorized('AUTH_REFRESH_INVALID');
  try {
    sessionResponse(res, await rotateRefreshToken(raw));
  } catch (err) {
    // Con un 401 la cookie ya no sirve: se borra. Un 409 (carrera) la deja: la otra pestaña la renovó.
    if (err instanceof AppError && err.status === 401) clearRefreshCookie(res);
    throw err;
  }
});

authRouter.post('/auth/logout', requireSameSiteRequest, async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (raw) {
    const token = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: { familyId: true, userId: true },
    });
    if (token) {
      await revokeFamily(token.familyId, 'logout');
      await audit({ action: 'auth.logout', entity: 'User', entityId: token.userId, userId: token.userId });
    }
  }
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.post(
  '/auth/logout-all',
  authenticate({ allowRestricted: true }),
  forbidImpersonation,
  forbidForDemoUsers,
  async (req, res) => {
    const { userId } = authOf(req);
    await revokeAllSessions(userId, 'logout_all');
    await audit({ action: 'auth.logout_all', entity: 'User', entityId: userId });
    clearRefreshCookie(res);
    res.status(204).end();
  },
);

authRouter.post(
  '/auth/change-password',
  authenticate({ allowRestricted: true }),
  forbidImpersonation,
  forbidForDemoUsers,
  async (req, res) => {
    const { userId, sessionId } = authOf(req);
    sessionResponse(res, await auth.changePassword(userId, sessionId, parse(ChangePasswordSchema, req.body)));
  },
);

authRouter.post('/auth/forgot', passwordResetLimiter, async (req, res) => {
  await auth.requestPasswordReset(parse(ForgotPasswordSchema, req.body).email);
  res.status(202).json({ status: 'accepted' });
});

authRouter.post('/auth/reset', passwordResetLimiter, async (req, res) => {
  await auth.resetPassword(parse(ResetPasswordSchema, req.body));
  res.status(204).end();
});

authRouter.post(
  '/auth/2fa/enroll',
  authenticate({ allowRestricted: true }),
  forbidImpersonation,
  forbidForDemoUsers,
  async (req, res) => {
    const { userId, restriction } = authOf(req);
    if (restriction === 'password_change') throw AppError.forbidden('PASSWORD_CHANGE_REQUIRED');
    res.json(await auth.startTotpEnrollment(userId));
  },
);

// Fin de una sesión de soporte: se llama con el access token de la impersonación.
authRouter.post('/auth/impersonation/stop', authenticate(), async (req, res) => {
  const { userId, sessionId, impersonatorId, accountId } = authOf(req);
  if (!impersonatorId) throw AppError.badRequest('NOT_IMPERSONATING');
  await stopImpersonation(sessionId, impersonatorId, userId, accountId);
  res.status(204).end();
});

authRouter.post(
  '/auth/2fa/confirm',
  authenticate({ allowRestricted: true }),
  forbidImpersonation,
  forbidForDemoUsers,
  async (req, res) => {
    const { userId, sessionId, restriction } = authOf(req);
    if (restriction === 'password_change') throw AppError.forbidden('PASSWORD_CHANGE_REQUIRED');
    const { accessToken, recoveryCodes } = await auth.confirmTotpEnrollment(
      userId,
      sessionId,
      parse(TotpConfirmSchema, req.body).code,
    );
    res.json({ accessToken, restriction: null, recoveryCodes });
  },
);

// Desactivar la verificación en dos pasos y regenerar los códigos de recuperación: piden la
// contraseña (y para desactivar, además, un código). Con el límite del login.
authRouter.post(
  '/auth/2fa/disable',
  loginLimiter,
  authenticate(),
  forbidImpersonation,
  forbidForDemoUsers,
  async (req, res) => {
    await auth.disableTotp(authOf(req).userId, parse(TotpDisableSchema, req.body));
    res.status(204).end();
  },
);

authRouter.post(
  '/auth/2fa/recovery-codes',
  loginLimiter,
  authenticate(),
  forbidImpersonation,
  forbidForDemoUsers,
  async (req, res) => {
    const { password } = parse(RecoveryCodesSchema, req.body);
    res.json(await auth.regenerateRecoveryCodes(authOf(req).userId, password));
  },
);
