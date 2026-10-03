import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { hashPassword } from '../../src/core/auth/password.js';
import {
  DEMO_ACCOUNT_DEFAULTS,
  DEMO_ACCOUNT_ID,
  DEMO_ADMIN_EMAIL,
  DEMO_SLUG,
  DEMO_USERS,
} from '../../src/modules/platform/demo/constants.js';
import { seedDemoData } from '../../src/modules/platform/demo/data.js';
import { syncDemoUsers } from '../../src/modules/platform/demo/users.js';

/**
 * Iglesia demo (SEED_DEMO=true), también en producción: la cuenta 1, compartida por los clientes que
 * prueban Shaddai. Tiene que ser lo primero que se crea para quedar con id 1. Usuarios demo con
 * SEED_DEMO_PASSWORD. Si ya existe, completa los datos de ejemplo que falten (idempotente); para
 * dejarla como nueva está el restablecimiento del panel de plataforma.
 */
export async function seedDemo(prisma: PrismaClient) {
  if (process.env.SEED_DEMO !== 'true') return;
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 12)
    throw new Error('Definí SEED_DEMO_PASSWORD (12+ caracteres) en .env');

  const existing = await prisma.account.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing) {
    console.log('✔ Iglesia demo ya existe');
    await seedDemoData(prisma, existing.id);
    return;
  }

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: DEMO_ACCOUNT_DEFAULTS.planCode } });
  const { createAccount } = await import('../../src/modules/platform/platform.service.js');
  const { account } = await createAccount({
    name: DEMO_ACCOUNT_DEFAULTS.name,
    slug: DEMO_SLUG,
    planId: plan.id,
    status: 'active',
    trialDays: 30,
    defaultLocale: DEMO_ACCOUNT_DEFAULTS.defaultLocale,
    timezone: DEMO_ACCOUNT_DEFAULTS.timezone,
    currency: DEMO_ACCOUNT_DEFAULTS.currency,
    sendAccessEmail: false,
    admin: { email: DEMO_ADMIN_EMAIL, firstName: DEMO_USERS[0].firstName, lastName: DEMO_USERS[0].lastName },
  });
  if (account.id !== DEMO_ACCOUNT_ID) {
    console.warn(
      `⚠ La iglesia demo quedó con id ${account.id} (se espera ${DEMO_ACCOUNT_ID}): el restablecimiento no la va a encontrar.`,
    );
  }
  await syncDemoUsers(prisma, account.id, await hashPassword(password));
  console.log(`✔ Iglesia demo creada con ${DEMO_USERS.length} usuarios (contraseña: SEED_DEMO_PASSWORD)`);
  await seedDemoData(prisma, account.id);
}
