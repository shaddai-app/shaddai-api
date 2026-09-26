import { env } from '../../config/env.js';
import { audit } from '../../core/audit/audit.js';
import { signTwoFactorChallenge, verifyTwoFactorChallenge } from '../../core/auth/jwt.js';
import { isLocked, lockDurationMs, MAX_FAILED_ATTEMPTS, retryAfterSeconds } from '../../core/auth/lockout.js';
import { hashPassword, verifyPassword } from '../../core/auth/password.js';
import { assertStrongPassword } from '../../core/auth/password-policy.js';
import { generateOpaqueToken, hashToken } from '../../core/auth/tokens.js';
import { createTotpSecret, decryptSecret, encryptSecret, verifyTotp } from '../../core/auth/totp.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';
import { sendMail } from '../../core/mail/mailer.js';
import { passwordResetMail, resolveMailLocale } from '../../core/mail/templates.js';
import {
  assertCanHoldSession,
  issueSession,
  revokeAllSessions,
  sessionUserSelect,
  signAccessFor,
  type IssuedSession,
} from './session.service.js';

const RESET_TOKEN_TTL_MS = 30 * 60_000;

const loginUserSelect = {
  ...sessionUserSelect,
  passwordHash: true,
  failedLoginCount: true,
  lockoutLevel: true,
  lockedUntil: true,
  totpSecretEnc: true,
} as const;

type LoginUser = NonNullable<Awaited<ReturnType<typeof findLoginUser>>>;

function findLoginUser(where: { email: string } | { id: number }) {
  return prisma.user.findUnique({ where, select: loginUserSelect });
}

// Hash fijo para que un email inexistente tarde lo mismo que uno válido (evita enumerar usuarios).
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('shaddai-dummy-password-for-timing'));

export type LoginResult =
  { requires2fa: true; challengeToken: string } | ({ requires2fa: false } & IssuedSession);

function assertNotLocked(user: LoginUser) {
  if (isLocked(user.lockedUntil)) {
    throw new AppError(423, 'AUTH_LOCKED', undefined, {
      retryAfterSeconds: retryAfterSeconds(user.lockedUntil!),
    });
  }
}

/** Cuenta un intento fallido; al llegar al máximo bloquea con duración progresiva. */
async function registerFailure(user: LoginUser, reason: string): Promise<never> {
  const failed = user.failedLoginCount + 1;
  const lock = failed >= MAX_FAILED_ATTEMPTS;
  const lockedUntil = lock ? new Date(Date.now() + lockDurationMs(user.lockoutLevel)) : null;
  await prisma.user.update({
    where: { id: user.id },
    data: lock
      ? { failedLoginCount: 0, lockoutLevel: { increment: 1 }, lockedUntil }
      : { failedLoginCount: failed },
  });
  await audit({
    action: 'auth.login.failure',
    entity: 'User',
    entityId: user.id,
    userId: user.id,
    accountId: user.accountId,
    after: { reason },
  });
  if (lock) {
    await audit({
      action: 'auth.lockout',
      entity: 'User',
      entityId: user.id,
      userId: user.id,
      accountId: user.accountId,
      after: { lockedUntil },
    });
    throw new AppError(423, 'AUTH_LOCKED', undefined, { retryAfterSeconds: retryAfterSeconds(lockedUntil!) });
  }
  throw AppError.unauthorized(reason === 'totp' ? 'AUTH_INVALID_CODE' : 'AUTH_INVALID_CREDENTIALS');
}

async function completeLogin(user: LoginUser, rememberMe: boolean): Promise<IssuedSession> {
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockoutLevel: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  const session = await issueSession(user, rememberMe);
  await audit({
    action: 'auth.login.success',
    entity: 'User',
    entityId: user.id,
    userId: user.id,
    accountId: user.accountId,
  });
  return session;
}

export async function login(input: {
  email: string;
  password: string;
  rememberMe: boolean;
}): Promise<LoginResult> {
  const user = await findLoginUser({ email: input.email });
  if (!user) {
    await verifyPassword(await getDummyHash(), input.password);
    await audit({
      action: 'auth.login.failure',
      userId: null,
      accountId: null,
      after: { reason: 'unknown_email' },
    });
    throw AppError.unauthorized('AUTH_INVALID_CREDENTIALS');
  }
  assertNotLocked(user);
  if (!(await verifyPassword(user.passwordHash, input.password))) return registerFailure(user, 'password');
  assertCanHoldSession(user);

  if (user.isPlatformAdmin && user.totpEnabled) {
    return {
      requires2fa: true,
      challengeToken: await signTwoFactorChallenge({ sub: String(user.id), rm: input.rememberMe }),
    };
  }
  return { requires2fa: false, ...(await completeLogin(user, input.rememberMe)) };
}

export async function verifyTwoFactor(input: {
  challengeToken: string;
  code: string;
}): Promise<IssuedSession> {
  const claims = await verifyTwoFactorChallenge(input.challengeToken);
  if (!claims) throw AppError.unauthorized('AUTH_2FA_CHALLENGE_INVALID');
  const user = await findLoginUser({ id: Number(claims.sub) });
  if (!user?.totpEnabled || !user.totpSecretEnc) throw AppError.unauthorized('AUTH_2FA_CHALLENGE_INVALID');
  assertNotLocked(user);
  if (!(await verifyTotp(decryptSecret(user.totpSecretEnc), input.code)))
    return registerFailure(user, 'totp');
  assertCanHoldSession(user);
  return completeLogin(user, claims.rm);
}

/** Cambio de contraseña (voluntario u obligatorio). Cierra todas las sesiones y abre una nueva. */
export async function changePassword(
  userId: number,
  sessionFamilyId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<IssuedSession> {
  const user = await findLoginUser({ id: userId });
  if (!user) throw AppError.unauthorized('AUTH_REQUIRED');
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw AppError.badRequest('PASSWORD_CURRENT_INVALID');
  }
  if (input.newPassword === input.currentPassword) throw AppError.badRequest('PASSWORD_SAME_AS_CURRENT');
  assertStrongPassword(input.newPassword, [user.email, user.firstName, user.lastName]);

  const rememberMe =
    (
      await prisma.refreshToken.findFirst({
        where: { familyId: sessionFamilyId },
        select: { rememberMe: true },
      })
    )?.rememberMe ?? false;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    },
    select: sessionUserSelect,
  });
  await revokeAllSessions(user.id, 'password_change');
  await audit({
    action: 'auth.password.change',
    entity: 'User',
    entityId: user.id,
    after: { wasForced: user.mustChangePassword },
  });
  return issueSession(updated, rememberMe);
}

/** Siempre responde igual exista o no el email (el controlador devuelve 202). */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      firstName: true,
      locale: true,
      accountId: true,
      isActive: true,
      deletedAt: true,
      account: { select: { defaultLocale: true } },
    },
  });
  if (!user || !user.isActive || user.deletedAt) return;

  const token = generateOpaqueToken();
  await prisma.$transaction([
    // Un solo enlace vigente por usuario.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    }),
  ]);

  const url = `${env.APP_URL}/restablecer?token=${encodeURIComponent(token)}`;
  const locale = resolveMailLocale(user.locale, user.account?.defaultLocale);
  await sendMail({ to: email, ...passwordResetMail(locale, user.firstName, url) });
  await audit({
    action: 'auth.password.reset_requested',
    entity: 'User',
    entityId: user.id,
    userId: user.id,
    accountId: user.accountId,
  });
}

export async function resetPassword(input: { token: string; newPassword: string }): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
    include: { user: { select: loginUserSelect } },
  });
  if (!record || record.usedAt || record.expiresAt <= new Date())
    throw AppError.badRequest('RESET_TOKEN_INVALID');
  const user = record.user;
  assertCanHoldSession(user);
  assertStrongPassword(input.newPassword, [user.email, user.firstName, user.lastName]);

  const { count } = await prisma.passwordResetToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count !== 1) throw AppError.badRequest('RESET_TOKEN_INVALID');

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await revokeAllSessions(user.id, 'password_reset');
  await audit({
    action: 'auth.password.reset',
    entity: 'User',
    entityId: user.id,
    userId: user.id,
    accountId: user.accountId,
  });
}

/** Paso 1 del enrolamiento TOTP: genera y guarda (cifrado) un secreto pendiente de confirmar. */
export async function startTotpEnrollment(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, totpEnabled: true },
  });
  if (!user) throw AppError.unauthorized('AUTH_REQUIRED');
  if (user.totpEnabled) throw AppError.conflict('TOTP_ALREADY_ENABLED');
  const { secret, uri } = createTotpSecret(user.email);
  await prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: encryptSecret(secret) } });
  return { secret, otpauthUri: uri };
}

/** Paso 2: confirma con un código válido. Devuelve un access token ya sin la restricción. */
export async function confirmTotpEnrollment(userId: number, sessionFamilyId: string, code: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpEnabled: true, totpSecretEnc: true },
  });
  if (!user) throw AppError.unauthorized('AUTH_REQUIRED');
  if (user.totpEnabled) throw AppError.conflict('TOTP_ALREADY_ENABLED');
  if (!user.totpSecretEnc) throw AppError.badRequest('TOTP_ENROLLMENT_NOT_STARTED');
  if (!(await verifyTotp(decryptSecret(user.totpSecretEnc), code)))
    throw AppError.badRequest('AUTH_INVALID_CODE');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { totpEnabled: true },
    select: sessionUserSelect,
  });
  await audit({ action: 'auth.totp.enabled', entity: 'User', entityId: userId });
  return { accessToken: await signAccessFor(updated, sessionFamilyId) };
}
