import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { hashPassword } from '../../src/core/auth/password.js';

export const DEMO_SLUG = 'iglesia-demo';

/**
 * SOLO DESARROLLO (SEED_DEMO=true): iglesia de prueba con usuarios de distintos roles para probar el
 * front sin usar la cuenta del superadmin. Todos comparten SEED_DEMO_PASSWORD (definida en .env).
 */
const DEMO_USERS = [
  { email: 'demo-admin@shaddai.local', firstName: 'Admin', lastName: 'Demo', role: 'admin', owner: true },
  { email: 'demo-pastor@shaddai.local', firstName: 'Pastor', lastName: 'Demo', role: 'pastor' },
  { email: 'demo-tesorero@shaddai.local', firstName: 'Tesorero', lastName: 'Demo', role: 'treasurer' },
  { email: 'demo-lider@shaddai.local', firstName: 'Líder', lastName: 'Demo', role: 'cell_leader' },
] as const;

export async function seedDemo(prisma: PrismaClient) {
  if (process.env.SEED_DEMO !== 'true') return;
  if (process.env.NODE_ENV === 'production') throw new Error('SEED_DEMO no se usa en producción.');
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 12)
    throw new Error('Definí SEED_DEMO_PASSWORD (12+ caracteres) en .env');

  if (await prisma.account.findUnique({ where: { slug: DEMO_SLUG } })) {
    console.log('✔ Iglesia demo ya existe');
    return;
  }

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'standard' } });
  const { createAccount } = await import('../../src/modules/platform/platform.service.js');
  const [owner, ...others] = DEMO_USERS;
  const { account, admin } = await createAccount({
    name: 'Iglesia Demo',
    slug: DEMO_SLUG,
    planId: plan.id,
    status: 'active',
    trialDays: 30,
    defaultLocale: 'es',
    timezone: 'America/Argentina/Buenos_Aires',
    currency: 'ARS',
    sendAccessEmail: false,
    admin: { email: owner.email, firstName: owner.firstName, lastName: owner.lastName },
  });

  const passwordHash = await hashPassword(password);
  await prisma.user.update({ where: { id: admin.id }, data: { passwordHash, mustChangePassword: false } });

  const roles = await prisma.role.findMany({ where: { accountId: account.id } });
  for (const u of others) {
    const role = roles.find((r) => r.systemKey === u.role)!;
    await prisma.user.create({
      data: {
        accountId: account.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        passwordHash,
        mustChangePassword: false,
        roles: { create: { roleId: role.id } },
      },
    });
  }
  console.log(`✔ Iglesia demo creada con ${DEMO_USERS.length} usuarios (contraseña: SEED_DEMO_PASSWORD)`);
}
