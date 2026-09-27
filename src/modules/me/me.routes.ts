import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';
import { parse } from '../../core/http/validate.js';
import { authenticate, authOf, forbidImpersonation } from '../../core/middleware/authenticate.js';
import { resolvePermissions } from '../../core/rbac/resolve.js';
import { listActiveSessions, revokeFamily } from '../auth/session.service.js';

export const meRouter = Router();

const UpdateMeSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    locale: z.enum(['es', 'en', 'pt']).nullable(), // null = usar el idioma por defecto de la cuenta
    theme: z.enum(['light', 'dark', 'auto']),
  })
  .partial()
  .strict();

async function loadMe(userId: number) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      locale: true,
      theme: true,
      isPlatformAdmin: true,
      isAccountOwner: true,
      totpEnabled: true,
      personId: true,
      account: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          defaultLocale: true,
          timezone: true,
          currency: true,
          weekStartsOn: true,
          primaryColor: true,
          trialEndsAt: true,
        },
      },
    },
  });
  const { account, ...rest } = user;
  return { user: rest, account };
}

// Permitido con sesión restringida: el front lo necesita para saber a qué pantalla mandar al usuario.
meRouter.get('/me', authenticate({ allowRestricted: true }), async (req, res) => {
  const { userId, restriction, isPlatformAdmin, impersonatorId } = authOf(req);
  const me = await loadMe(userId);
  res.json({
    ...me,
    permissions: isPlatformAdmin ? {} : await resolvePermissions(userId),
    restriction,
    impersonation: impersonatorId ? { impersonatorId } : null, // el front muestra el banner fijo
  });
});

meRouter.patch('/me', authenticate(), forbidImpersonation, async (req, res) => {
  const { userId } = authOf(req);
  const data = parse(UpdateMeSchema, req.body);
  await prisma.user.update({ where: { id: userId }, data });
  res.json(await loadMe(userId));
});

meRouter.get('/me/sessions', authenticate(), async (req, res) => {
  const { userId, sessionId } = authOf(req);
  const sessions = await listActiveSessions(userId);
  res.json({
    items: sessions.map((s) => ({
      id: s.familyId,
      current: s.familyId === sessionId,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      support: s.impersonatorId !== null, // sesión de soporte del superadmin
    })),
  });
});

meRouter.delete('/me/sessions/:id', authenticate(), forbidImpersonation, async (req, res) => {
  const { userId } = authOf(req);
  const familyId = z.uuid().parse(req.params.id);
  const owned = await prisma.refreshToken.findFirst({ where: { familyId, userId }, select: { id: true } });
  if (!owned) throw AppError.notFound('SESSION_NOT_FOUND');
  await revokeFamily(familyId, 'user_revoked');
  await audit({ action: 'auth.session.revoke', entity: 'Session', entityId: familyId });
  res.status(204).end();
});
