import type { z } from 'zod';
import { env } from '../../config/env.js';
import { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { generateTemporaryPassword, hashPassword } from '../../core/auth/password.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { paged, toSkipTake } from '../../core/http/pagination.js';
import { sendMail } from '../../core/mail/mailer.js';
import { resolveMailLocale, temporaryAccessMail } from '../../core/mail/templates.js';
import { invalidateUserPermissions } from '../../core/rbac/permission-cache.js';
import { ADMIN_ROLE_KEY } from '../../core/rbac/resolve.js';
import { sendSecurityAlert } from '../auth/two-factor.js';
import type { CreateUserSchema, ListUsersQuery, UpdateUserSchema } from './users.schemas.js';

const adminRoleFilter = { systemKey: ADMIN_ROLE_KEY, isLocked: true } as const;

const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  locale: true,
  isActive: true,
  isAccountOwner: true,
  mustChangePassword: true,
  totpEnabled: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { select: { role: { select: { id: true, name: true, systemKey: true, isLocked: true } } } },
  person: { select: { id: true, firstName: true, lastName: true, deletedAt: true } },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

const present = (u: UserRow) => {
  const { roles, lockedUntil, person, ...rest } = u;
  return {
    ...rest,
    person:
      person && !person.deletedAt
        ? { id: person.id, firstName: person.firstName, lastName: person.lastName }
        : null,
    locked: lockedUntil !== null && lockedUntil > new Date(),
    lockedUntil,
    roles: roles.map((r) => r.role),
    isAdmin: roles.some((r) => r.role.systemKey === ADMIN_ROLE_KEY && r.role.isLocked),
  };
};

async function findUser(id: number): Promise<UserRow> {
  const user = await tenantDb().user.findFirst({ where: { id, deletedAt: null }, select: userSelect });
  if (!user) throw AppError.notFound('USER_NOT_FOUND');
  return user;
}

export async function usage() {
  const db = tenantDb();
  const [active, account] = await Promise.all([
    db.user.count({ where: { isActive: true, deletedAt: null } }),
    db.account.findUniqueOrThrow({ where: { id: currentAccountId() }, select: { userLimit: true } }),
  ]);
  return { activeUsers: active, userLimit: account.userLimit };
}

/** El límite solo bloquea altas y reactivaciones; nunca desactiva usuarios existentes. */
async function assertCapacity() {
  const { activeUsers, userLimit } = await usage();
  if (activeUsers >= userLimit) throw AppError.conflict('USER_LIMIT_REACHED', { activeUsers, userLimit });
}

/** La cuenta nunca puede quedarse sin un administrador activo. */
async function assertAnotherActiveAdmin(excludingUserId: number) {
  const others = await tenantDb().user.count({
    where: {
      id: { not: excludingUserId },
      isActive: true,
      deletedAt: null,
      roles: { some: { role: adminRoleFilter } },
    },
  });
  if (others === 0) throw AppError.conflict('LAST_ADMIN');
}

async function assertRolesOwned(roleIds: number[]) {
  const unique = [...new Set(roleIds)];
  const found = await tenantDb().role.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw AppError.badRequest('ROLE_INVALID');
  return unique;
}

/** Una ficha de persona se vincula a lo sumo con un usuario (unicidad validada acá, ver schema). */
async function assertPersonLinkable(personId: number, userId: number) {
  const db = tenantDb();
  if (!(await db.person.count({ where: { id: personId, deletedAt: null } }))) {
    throw AppError.badRequest('PERSON_INVALID');
  }
  const other = await db.user.count({ where: { personId, id: { not: userId }, deletedAt: null } });
  if (other > 0) throw AppError.conflict('PERSON_ALREADY_LINKED');
}

async function adminRoleIds(): Promise<Set<number>> {
  const roles = await tenantDb().role.findMany({ where: adminRoleFilter, select: { id: true } });
  return new Set(roles.map((r) => r.id));
}

async function sendAccess(
  user: { email: string; firstName: string; locale: string | null },
  password: string,
) {
  const account = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { name: true, defaultLocale: true },
  });
  const locale = resolveMailLocale(user.locale, account.defaultLocale);
  await sendMail({
    to: user.email,
    ...temporaryAccessMail(locale, {
      name: user.firstName,
      church: account.name,
      password,
      url: `${env.APP_URL}/login`,
    }),
  });
}

export async function listUsers(query: z.infer<typeof ListUsersQuery>) {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.status ? { isActive: query.status === 'active' } : {}),
    ...(query.roleId ? { roles: { some: { roleId: query.roleId } } } : {}),
    ...(query.q
      ? {
          OR: [
            { email: { contains: query.q } },
            { firstName: { contains: query.q } },
            { lastName: { contains: query.q } },
          ],
        }
      : {}),
  };
  const db = tenantDb();
  const [rows, total, limits] = await Promise.all([
    db.user.findMany({
      where,
      select: userSelect,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      ...toSkipTake(query),
    }),
    db.user.count({ where }),
    usage(),
  ]);
  return { ...paged(rows.map(present), total, query), usage: limits };
}

export async function getUser(id: number) {
  return present(await findUser(id));
}

export async function createUser(input: z.infer<typeof CreateUserSchema>) {
  await assertCapacity();
  const roleIds = await assertRolesOwned(input.roleIds);
  const temporaryPassword = generateTemporaryPassword();
  const db = tenantDb();

  let created: UserRow;
  try {
    created = await db.user.create({
      data: {
        accountId: currentAccountId(),
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        locale: input.locale ?? null,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
      },
      select: userSelect,
    });
  } catch (err) {
    // El email es único en toda la plataforma; no se revela en qué cuenta está.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('EMAIL_IN_USE');
    }
    throw err;
  }
  if (roleIds.length)
    await db.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: created.id, roleId })) });

  await audit({
    action: 'users.create',
    entity: 'User',
    entityId: created.id,
    after: { email: created.email, roleIds },
  });
  if (input.sendAccessEmail) await sendAccess(created, temporaryPassword);
  return { user: await getUser(created.id), temporaryPassword };
}

export async function updateUser(actorId: number, id: number, input: z.infer<typeof UpdateUserSchema>) {
  const before = await findUser(id);
  const db = tenantDb();

  if (input.roleIds) {
    const roleIds = await assertRolesOwned(input.roleIds);
    const admins = await adminRoleIds();
    const wasAdmin = before.roles.some((r) => admins.has(r.role.id));
    const willBeAdmin = roleIds.some((r) => admins.has(r));
    if (wasAdmin && !willBeAdmin) {
      if (before.isAccountOwner) throw AppError.forbidden('OWNER_PROTECTED');
      if (before.isActive) await assertAnotherActiveAdmin(id);
    }
    await db.$transaction([
      db.userRole.deleteMany({ where: { userId: id } }),
      db.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) }),
    ]);
    invalidateUserPermissions(id);
  }

  if (input.personId) await assertPersonLinkable(input.personId, id);

  const { roleIds: _roles, ...profile } = input;
  if (Object.keys(profile).length) await db.user.update({ where: { id }, data: profile });

  const after = await getUser(id);
  await audit({
    action: 'users.update',
    entity: 'User',
    entityId: id,
    before: { ...present(before), roles: before.roles.map((r) => r.role.id) },
    after: { ...after, roles: after.roles.map((r) => r.id), actorId },
  });
  return after;
}

export async function setActive(actorId: number, id: number, active: boolean) {
  const user = await findUser(id);
  if (user.isActive === active) return present(user);
  const db = tenantDb();

  if (active) {
    await assertCapacity();
  } else {
    if (id === actorId) throw AppError.conflict('CANNOT_DEACTIVATE_SELF');
    if (user.isAccountOwner) throw AppError.forbidden('OWNER_PROTECTED');
    if (user.roles.some((r) => r.role.systemKey === ADMIN_ROLE_KEY && r.role.isLocked))
      await assertAnotherActiveAdmin(id);
  }

  await db.user.update({ where: { id }, data: { isActive: active } });
  if (!active) {
    await db.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'deactivated' },
    });
  }
  await audit({ action: active ? 'users.activate' : 'users.deactivate', entity: 'User', entityId: id });
  return getUser(id);
}

export async function unlock(id: number) {
  await findUser(id);
  await tenantDb().user.update({
    where: { id },
    data: { lockedUntil: null, failedLoginCount: 0, lockoutLevel: 0 },
  });
  await audit({ action: 'users.unlock', entity: 'User', entityId: id });
  return getUser(id);
}

/** Reset por el admin de la cuenta: temporal de un solo uso, desbloquea y cierra sesiones. */
/**
 * Restablece la verificación en dos pasos de un usuario que perdió el celular y los códigos de
 * recuperación: vuelve a entrar solo con la contraseña. Cierra sus sesiones y le avisa por mail.
 */
export async function resetTwoFactor(actorId: number, id: number) {
  if (id === actorId) throw AppError.conflict('USE_SECURITY_SETTINGS'); // para uno mismo: Seguridad
  const user = await findUser(id);
  if (!user.totpEnabled) throw AppError.conflict('TOTP_NOT_ENABLED');
  const db = tenantDb();
  await db.user.update({ where: { id }, data: { totpEnabled: false, totpSecretEnc: null } });
  await db.totpRecoveryCode.deleteMany({ where: { userId: id } });
  await db.refreshToken.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'admin' },
  });
  await audit({ action: 'users.reset_2fa', entity: 'User', entityId: id });
  const account = await db.account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { defaultLocale: true },
  });
  await sendSecurityAlert({ ...user, account }, 'totp_reset');
  return getUser(id);
}

export async function resetPassword(actorId: number, id: number, sendAccessEmail: boolean) {
  if (id === actorId) throw AppError.conflict('USE_CHANGE_PASSWORD'); // para uno mismo: cambio de contraseña
  const user = await findUser(id);
  const temporaryPassword = generateTemporaryPassword();
  const db = tenantDb();
  await db.user.update({
    where: { id },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      passwordChangedAt: new Date(),
      lockedUntil: null,
      failedLoginCount: 0,
      lockoutLevel: 0,
    },
  });
  await db.refreshToken.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'admin' },
  });
  await audit({ action: 'users.reset_password', entity: 'User', entityId: id });
  if (sendAccessEmail) await sendAccess(user, temporaryPassword);
  return { user: await getUser(id), temporaryPassword };
}
