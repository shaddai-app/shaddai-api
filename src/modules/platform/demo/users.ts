import type { PrismaClient } from '../../../generated/prisma/client.js';
import { DEMO_USERS, QA_USERS } from './constants.js';

/**
 * Deja los usuarios demo como recién creados: los crea si faltan y, si existen, les vuelve a poner
 * nombre, contraseña, rol por defecto y les saca 2FA, bloqueos y bajas. `passwordChangedAt` invalida
 * los access tokens vigentes. Con `includeQa`, además reasigna el rol a los usuarios QA que existan
 * (sin tocar su contraseña). Supone que los roles por defecto de la cuenta ya existen.
 */
export async function syncDemoUsers(
  prisma: PrismaClient,
  accountId: number,
  passwordHash: string,
  { includeQa = false }: { includeQa?: boolean } = {},
) {
  const roles = await prisma.role.findMany({ where: { accountId }, select: { id: true, systemKey: true } });
  const roleId = (key: string) => roles.find((r) => r.systemKey === key)!.id;
  const now = new Date();
  const unlocked = {
    failedLoginCount: 0,
    lockoutLevel: 0,
    lockedUntil: null,
    isActive: true,
    deletedAt: null,
  };

  for (const u of DEMO_USERS) {
    const data = {
      firstName: u.firstName,
      lastName: u.lastName,
      passwordHash,
      mustChangePassword: false,
      passwordChangedAt: now,
      isAccountOwner: u.owner,
      totpEnabled: false,
      totpSecretEnc: null,
      personId: null,
      ...unlocked,
    };
    const existing = await prisma.user.findFirst({
      where: { accountId, email: u.email },
      select: { id: true },
    });
    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data })
      : await prisma.user.create({ data: { ...data, accountId, email: u.email } });
    await setRole(prisma, user.id, roleId(u.role));
  }

  if (!includeQa) return;
  const qa = await prisma.user.findMany({
    where: { accountId, email: { in: Object.keys(QA_USERS) } },
    select: { id: true, email: true },
  });
  for (const u of qa) {
    await prisma.user.update({ where: { id: u.id }, data: { personId: null, ...unlocked } });
    await setRole(prisma, u.id, roleId(QA_USERS[u.email]!));
  }
}

async function setRole(prisma: PrismaClient, userId: number, roleId: number) {
  await prisma.userRole.deleteMany({ where: { userId } });
  await prisma.userRole.create({ data: { userId, roleId } });
}
