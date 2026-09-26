import { randomUUID } from 'node:crypto';
import { audit } from '../../core/audit/audit.js';
import { signAccessToken } from '../../core/auth/jwt.js';
import { generateOpaqueToken, hashToken } from '../../core/auth/tokens.js';
import { getContext } from '../../core/context.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';
import {
  assertCanHoldSession,
  passwordVersion,
  revokeFamily,
  sessionUserSelect,
} from '../auth/session.service.js';

export const IMPERSONATION_TTL_MIN = 30;

/**
 * Sesión de soporte: el superadmin actúa como un usuario de una cuenta. No hay refresh (vence a los
 * 30 min), queda registrada como familia con impersonatorId y todas las acciones se auditan con él.
 */
export async function startImpersonation(adminId: number, targetUserId: number, reason: string) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: sessionUserSelect });
  if (!target || target.accountId === null) throw AppError.notFound('USER_NOT_FOUND');
  if (target.isPlatformAdmin) throw AppError.forbidden('IMPERSONATION_TARGET_INVALID');
  assertCanHoldSession(target);

  const familyId = randomUUID();
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MIN * 60_000);
  const ctx = getContext();
  await prisma.refreshToken.create({
    data: {
      userId: target.id,
      familyId,
      // Token descartado: esta familia nunca se renueva, solo sirve para poder revocarla.
      tokenHash: hashToken(generateOpaqueToken()),
      impersonatorId: adminId,
      expiresAt,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      lastUsedAt: new Date(),
    },
  });

  const accessToken = await signAccessToken(
    { sub: String(target.id), sid: familyId, ver: passwordVersion(target), imp: String(adminId) },
    IMPERSONATION_TTL_MIN,
  );
  await audit({
    action: 'platform.impersonation.start',
    entity: 'User',
    entityId: target.id,
    userId: adminId,
    accountId: target.accountId,
    after: { reason, familyId, expiresAt },
  });
  return {
    accessToken,
    expiresAt,
    user: { id: target.id, email: target.email, accountId: target.accountId },
  };
}

export async function stopImpersonation(
  familyId: string,
  adminId: number,
  targetUserId: number,
  accountId: number | null,
) {
  await revokeFamily(familyId, 'impersonation_end');
  await audit({
    action: 'platform.impersonation.stop',
    entity: 'User',
    entityId: targetUserId,
    userId: adminId,
    accountId,
    after: { familyId },
  });
}
