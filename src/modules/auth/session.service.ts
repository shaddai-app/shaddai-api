import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit/audit.js';
import { signAccessToken } from '../../core/auth/jwt.js';
import { generateOpaqueToken, hashToken } from '../../core/auth/tokens.js';
import { getContext } from '../../core/context.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';

/** Sesión restringida: solo puede completar el paso pendiente (ver authenticate({ allowRestricted })). */
export type SessionRestriction = 'password_change' | 'totp_enroll' | null;

/** Si un refresh ya rotado se reusa dentro de esta ventana, se asume carrera entre pestañas y no robo. */
export const REFRESH_REUSE_GRACE_MS = 15_000;

export const sessionUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  accountId: true,
  isPlatformAdmin: true,
  isActive: true,
  deletedAt: true,
  mustChangePassword: true,
  passwordChangedAt: true,
  totpEnabled: true,
  locale: true,
  theme: true,
  account: { select: { status: true, defaultLocale: true, trialEndsAt: true } },
} as const;

export interface SessionUser {
  id: number;
  accountId: number | null;
  isPlatformAdmin: boolean;
  isActive: boolean;
  deletedAt: Date | null;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  totpEnabled: boolean;
  account: { status: string; trialEndsAt?: Date | null } | null;
}

export function restrictionFor(
  user: Pick<SessionUser, 'mustChangePassword' | 'isPlatformAdmin' | 'totpEnabled'>,
): SessionRestriction {
  if (user.mustChangePassword) return 'password_change';
  if (user.isPlatformAdmin && !user.totpEnabled) return 'totp_enroll';
  return null;
}

export const passwordVersion = (user: Pick<SessionUser, 'passwordChangedAt'>) =>
  user.passwordChangedAt ? Math.floor(user.passwordChangedAt.getTime() / 1000) : 0;

/** Usuario inactivo o cuenta suspendida/cerrada no pueden iniciar ni sostener sesión. */
export function assertCanHoldSession(user: SessionUser): void {
  if (!user.isActive || user.deletedAt) throw AppError.forbidden('USER_INACTIVE');
  if (!user.isPlatformAdmin && user.account && ['suspended', 'closed'].includes(user.account.status)) {
    throw AppError.forbidden('ACCOUNT_SUSPENDED');
  }
}

/** Morosa o con la prueba vencida: puede entrar y consultar, pero no modificar datos. */
export function isAccountReadOnly(account: SessionUser['account'], now = new Date()): boolean {
  if (!account) return false;
  if (account.status === 'past_due') return true;
  return account.status === 'trial' && !!account.trialEndsAt && account.trialEndsAt <= now;
}

export function signAccessFor(user: SessionUser, familyId: string) {
  return signAccessToken({ sub: String(user.id), sid: familyId, ver: passwordVersion(user) });
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  familyId: string;
  restriction: SessionRestriction;
}

function refreshExpiry(rememberMe: boolean): Date {
  const days = rememberMe ? env.REFRESH_REMEMBER_TTL_DAYS : env.REFRESH_TTL_DAYS;
  return new Date(Date.now() + days * 86_400_000);
}

/** Abre una sesión nueva (nueva familia de refresh tokens). */
export async function issueSession(user: SessionUser, rememberMe: boolean): Promise<IssuedSession> {
  const ctx = getContext();
  const familyId = randomUUID();
  const refreshToken = generateOpaqueToken();
  const refreshExpiresAt = refreshExpiry(rememberMe);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      rememberMe,
      expiresAt: refreshExpiresAt,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      lastUsedAt: new Date(),
    },
  });

  return {
    accessToken: await signAccessFor(user, familyId),
    refreshToken,
    refreshExpiresAt,
    familyId,
    restriction: restrictionFor(user),
  };
}

/**
 * Rota el refresh: el token usado queda revocado ("rotated") y se emite uno nuevo en la misma familia.
 * Reusar un token ya rotado fuera de la ventana de gracia = posible robo → se revoca toda la familia.
 */
export async function rotateRefreshToken(rawToken: string): Promise<IssuedSession & { user: SessionUser }> {
  const current = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: { select: sessionUserSelect } },
  });
  if (!current) throw AppError.unauthorized('AUTH_REFRESH_INVALID');

  const now = new Date();
  if (current.revokedAt) {
    if (current.revokedReason === 'rotated') {
      if (now.getTime() - current.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
        // Otra pestaña ya renovó: el navegador tiene la cookie nueva, el front reintenta.
        throw AppError.conflict('AUTH_REFRESH_RACE');
      }
      await revokeFamily(current.familyId, 'reuse');
      await audit({
        action: 'auth.refresh.reuse_detected',
        entity: 'User',
        entityId: current.userId,
        userId: current.userId,
        accountId: current.user.accountId,
      });
      throw AppError.unauthorized('AUTH_REFRESH_REUSED');
    }
    throw AppError.unauthorized('AUTH_REFRESH_INVALID');
  }
  if (current.expiresAt <= now) throw AppError.unauthorized('AUTH_REFRESH_EXPIRED');

  const user = current.user;
  assertCanHoldSession(user);

  const refreshToken = generateOpaqueToken();
  const ctx = getContext();
  const created = await prisma.$transaction(async (tx) => {
    // Marca atómica: si dos requests rotan el mismo token a la vez, solo una gana.
    const { count } = await tx.refreshToken.updateMany({
      where: { id: current.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'rotated' },
    });
    if (count !== 1) throw AppError.conflict('AUTH_REFRESH_RACE');
    const next = await tx.refreshToken.create({
      data: {
        userId: user.id,
        familyId: current.familyId,
        tokenHash: hashToken(refreshToken),
        rememberMe: current.rememberMe,
        impersonatorId: current.impersonatorId,
        expiresAt: current.expiresAt, // la familia no se extiende más allá del login original
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        lastUsedAt: now,
      },
    });
    await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: next.id } });
    return next;
  });

  return {
    user,
    accessToken: await signAccessFor(user, current.familyId),
    refreshToken,
    refreshExpiresAt: created.expiresAt,
    familyId: current.familyId,
    restriction: restrictionFor(user),
  };
}

export async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function revokeAllSessions(
  userId: number,
  reason: string,
  exceptFamilyId?: string,
): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null, ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}) },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function isFamilyActive(familyId: string): Promise<boolean> {
  const token = await prisma.refreshToken.findFirst({
    where: { familyId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return token !== null;
}

/** Sesiones activas del usuario (una por familia: el token vigente). */
export async function listActiveSessions(userId: number) {
  const tokens = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: {
      familyId: true,
      ip: true,
      userAgent: true,
      lastUsedAt: true,
      expiresAt: true,
      rememberMe: true,
      impersonatorId: true,
    },
  });
  const firstUse = await prisma.refreshToken.groupBy({
    by: ['familyId'],
    where: { familyId: { in: tokens.map((t) => t.familyId) } },
    _min: { createdAt: true },
  });
  const createdByFamily = new Map(firstUse.map((f) => [f.familyId, f._min.createdAt]));
  return tokens.map((t) => ({ ...t, createdAt: createdByFamily.get(t.familyId) ?? null }));
}
