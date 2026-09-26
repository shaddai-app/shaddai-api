import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PERMISSIONS } from '../../src/core/rbac/catalog.js';

export async function seedPermissions(prisma: PrismaClient) {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      create: p,
      update: { module: p.module, action: p.action, supportsScope: p.supportsScope, sortOrder: p.sortOrder },
    });
  }
  console.log(`✔ Permisos: ${PERMISSIONS.length}`);
}
