import request from 'supertest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/core/auth/password.js';
import { encryptSecret } from '../../src/core/auth/totp.js';
import { prisma } from '../../src/core/db/prisma.js';
import { memoryOutbox } from '../../src/core/mail/mailer.js';

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
  await prisma.catalogItem.deleteMany();
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
