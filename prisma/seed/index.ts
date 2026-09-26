import { prisma } from '../../src/core/db/prisma.js';
import { seedPermissions } from './permissions.js';
import { seedPlans } from './plans.js';
import { seedSuperadmin } from './superadmin.js';

// Idempotente: se puede correr varias veces sin duplicar datos.
async function main() {
  await seedSuperadmin(prisma); // primero: debe quedar con Id=1
  await seedPermissions(prisma);
  await seedPlans(prisma);
}

main()
  .catch((err) => {
    console.error('✖ Seed falló:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
