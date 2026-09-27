import request from 'supertest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/core/auth/password.js';
import { encryptSecret } from '../../src/core/auth/totp.js';
import { prisma } from '../../src/core/db/prisma.js';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import type { PermissionKey } from '../../src/core/rbac/catalog.js';
import { invalidateAllPermissions } from '../../src/core/rbac/permission-cache.js';
import { issueSession } from '../../src/modules/auth/session.service.js';

export const app = createApp();
export { prisma };

export const STRONG_PASSWORD = 'correcto-caballo-bateria-grapa';
export const NEW_STRONG_PASSWORD = 'montaña-violeta-tranvía-azul';

/** Borra datos de negocio respetando FKs. Los permisos (catálogo global) se conservan. */
export async function resetDb() {
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.user.deleteMany();
  await prisma.personTag.deleteMany();
  await prisma.personMilestone.deleteMany();
  await prisma.personPosition.deleteMany();
  await prisma.personStatusHistory.deleteMany();
  await prisma.person.deleteMany();
  await prisma.household.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.catalogItem.deleteMany();
  await prisma.fileObject.deleteMany();
  await prisma.campus.deleteMany();
  await prisma.account.deleteMany();
  await prisma.plan.deleteMany();
  memoryOutbox.length = 0;
}

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function createAccount(overrides: { status?: string } = {}) {
  const plan = await prisma.plan.create({
    data: { code: `p-${unique()}`, name: 'Plan test', userLimit: 5, storageLimitMb: 100, priceUsd: '0' },
  });
  return prisma.account.create({
    data: {
      name: 'Iglesia Test',
      slug: `iglesia-${unique()}`,
      planId: plan.id,
      userLimit: 5,
      storageLimitMb: 100,
      status: overrides.status ?? 'active',
    },
  });
}

export async function createUser(
  options: {
    accountId?: number | null;
    password?: string;
    mustChangePassword?: boolean;
    isPlatformAdmin?: boolean;
    totpSecret?: string;
    isActive?: boolean;
  } = {},
) {
  const password = options.password ?? STRONG_PASSWORD;
  const user = await prisma.user.create({
    data: {
      email: `user-${unique()}@test.local`,
      passwordHash: await hashPassword(password),
      firstName: 'Ana',
      lastName: 'Prueba',
      accountId: options.accountId ?? null,
      isPlatformAdmin: options.isPlatformAdmin ?? false,
      mustChangePassword: options.mustChangePassword ?? false,
      isActive: options.isActive ?? true,
      totpEnabled: Boolean(options.totpSecret),
      totpSecretEnc: options.totpSecret ? encryptSecret(options.totpSecret) : null,
    },
  });
  return { ...user, password };
}

/** Un usuario común de una cuenta activa, sin restricciones. */
export async function createAccountUser(options: Parameters<typeof createUser>[0] = {}) {
  const account = await createAccount();
  return createUser({ accountId: account.id, ...options });
}

/** Crea un rol con permisos {clave: scope} y lo asigna al usuario. */
export async function grantRole(
  user: { id: number; accountId: number | null },
  permissions: Partial<Record<PermissionKey, 'all' | 'own'>>,
  options: { systemKey?: string; isLocked?: boolean } = {},
) {
  const keys = Object.keys(permissions);
  const perms = await prisma.permission.findMany({ where: { key: { in: keys } } });
  if (perms.length !== keys.length) throw new Error(`Permisos inexistentes en ${keys.join(', ')}`);
  const role = await prisma.role.create({
    data: {
      accountId: user.accountId!,
      name: `rol-${unique()}`,
      systemKey: options.systemKey ?? null,
      isLocked: options.isLocked ?? false,
      permissions: {
        create: perms.map((p) => ({ permissionId: p.id, scope: permissions[p.key as PermissionKey]! })),
      },
    },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  invalidateAllPermissions();
  return role;
}

/** Superadmin con 2FA enrolado y sesión completa (sin pasar por el challenge TOTP). */
export async function platformAdmin() {
  const admin = await createUser({ isPlatformAdmin: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
  const full = await prisma.user.findUniqueOrThrow({ where: { id: admin.id }, include: { account: true } });
  const session = await issueSession(full, false);
  return { user: admin, headers: bearer(session.accessToken) };
}

/**
 * Iglesia dada de alta como en producción (roles por defecto, catálogos, sede) con su dueño ya
 * logueado y sin cambio de contraseña pendiente.
 */
export async function provisionChurch(overrides: { userLimit?: number; storageLimitMb?: number } = {}) {
  const { createAccount: createChurch } = await import('../../src/modules/platform/platform.service.js');
  const plan = await prisma.plan.create({
    data: { code: `p-${unique()}`, name: 'Plan', userLimit: 10, storageLimitMb: 50, priceUsd: '0' },
  });
  const created = await createChurch({
    name: `Iglesia ${unique()}`,
    planId: plan.id,
    status: 'active',
    trialDays: 30,
    defaultLocale: 'es',
    timezone: 'America/Argentina/Buenos_Aires',
    currency: 'ARS',
    sendAccessEmail: false,
    admin: { email: `owner-${unique()}@test.local`, firstName: 'Dueño', lastName: 'Iglesia' },
    ...overrides,
  });
  const ownerId = created.admin.id;
  await prisma.user.update({ where: { id: ownerId }, data: { mustChangePassword: false } });
  const session = await loginAs({ email: created.admin.email, password: created.temporaryPassword });
  const roles = await prisma.role.findMany({ where: { accountId: created.account.id } });
  const roleId = (systemKey: string) => roles.find((r) => r.systemKey === systemKey)!.id;
  return {
    accountId: created.account.id as number,
    ownerId,
    headers: bearer(session.accessToken),
    roleId,
  };
}

/** Cuenta + usuario con los permisos dados, ya logueado. */
export async function actor(
  permissions: Partial<Record<PermissionKey, 'all' | 'own'>> = {},
  accountId?: number,
) {
  const account = accountId ?? (await createAccount()).id;
  const user = await createUser({ accountId: account });
  if (Object.keys(permissions).length) await grantRole(user, permissions);
  const session = await loginAs(user);
  return { user, accountId: account, token: session.accessToken, headers: bearer(session.accessToken) };
}

export const csrf = { 'X-Requested-With': 'shaddai' };

export function refreshCookieFrom(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('sh_rt='));
  if (!cookie) throw new Error('La respuesta no trae cookie sh_rt');
  return cookie.split(';')[0]!;
}

export async function loginAs(user: { email: string; password: string }, rememberMe = false) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: user.password, rememberMe });
  if (res.status !== 200) throw new Error(`Login falló: ${res.status} ${JSON.stringify(res.body)}`);
  return { accessToken: res.body.accessToken as string, cookie: refreshCookieFrom(res), body: res.body };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
