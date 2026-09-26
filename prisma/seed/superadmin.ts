import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { generateTemporaryPassword, hashPassword } from '../../src/core/auth/password.js';

export async function seedSuperadmin(prisma: PrismaClient) {
  const existing = await prisma.user.findUnique({ where: { id: 1 } });
  if (existing) {
    if (!existing.isPlatformAdmin) throw new Error('El usuario Id=1 existe pero no es superadmin.');
    console.log(`✔ Superadmin ya existe (Id=1, ${existing.email})`);
    return;
  }
  if ((await prisma.user.count()) > 0) {
    throw new Error('Hay usuarios pero ninguno con Id=1: el superadmin debe ser el primer usuario creado.');
  }

  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Falta SEED_SUPERADMIN_EMAIL en .env');

  const tempPassword = generateTemporaryPassword();
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(tempPassword),
      firstName: process.env.SEED_SUPERADMIN_FIRST_NAME ?? 'Super',
      lastName: process.env.SEED_SUPERADMIN_LAST_NAME ?? 'Admin',
      isPlatformAdmin: true,
      mustChangePassword: true,
    },
  });
  if (user.id !== 1) {
    throw new Error(`El superadmin quedó con Id=${user.id} (se esperaba 1). Recreá la base con db:reset.`);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log(' Superadmin creado (Id=1)');
  console.log(`   Email:                ${email}`);
  console.log(`   Contraseña temporal:  ${tempPassword}`);
  console.log(' Se muestra UNA sola vez. En el primer login se exige cambiarla.');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
}
