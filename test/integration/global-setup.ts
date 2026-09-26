import { execSync } from 'node:child_process';
import { applyTestEnv } from './test-env.js';

// Prepara la base de test con `migrate deploy` (no destructivo: crea la base si falta y aplica
// migraciones pendientes). Cada test limpia sus datos con resetDb(). Luego siembra permisos.
export default async function setup() {
  applyTestEnv();
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
  const { prisma } = await import('../../src/core/db/prisma.js');
  const { seedPermissions } = await import('../../prisma/seed/permissions.js');
  await seedPermissions(prisma);
  await prisma.$disconnect();
}
