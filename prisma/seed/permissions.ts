import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PERMISSIONS } from '../../src/core/rbac/catalog.js';
import { DEFAULT_ROLES } from '../../src/core/rbac/default-roles.js';

export async function seedPermissions(prisma: PrismaClient) {
  const existing = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      create: p,
      update: { module: p.module, action: p.action, supportsScope: p.supportsScope, sortOrder: p.sortOrder },
    });
  }
  console.log(`✔ Permisos: ${PERMISSIONS.length}`);

  // Base nueva: todavía no hay iglesias. Si no, los permisos que aparecen por primera vez (un módulo
  // nuevo) se dan a los roles del sistema de las iglesias que ya existen, según la matriz por defecto.
  // Pasa una sola vez (al crearse el permiso): si después una iglesia se lo saca a un rol, queda así.
  const added = PERMISSIONS.filter((p) => !existing.has(p.key));
  if (existing.size > 0 && added.length > 0) await grantToSystemRoles(prisma, added);
}

async function grantToSystemRoles(prisma: PrismaClient, added: typeof PERMISSIONS) {
  const ids = new Map(
    (await prisma.permission.findMany({ where: { key: { in: added.map((p) => p.key) } } })).map((p) => [
      p.key,
      p.id,
    ]),
  );
  for (const role of DEFAULT_ROLES) {
    const grants = added.filter((p) => role.grants[p.key]);
    if (!grants.length) continue;
    const roles = await prisma.role.findMany({ where: { systemKey: role.systemKey }, select: { id: true } });
    if (!roles.length) continue;
    await prisma.rolePermission.createMany({
      data: roles.flatMap((r) =>
        grants.map((p) => ({
          roleId: r.id,
          permissionId: ids.get(p.key)!,
          // Un permiso sin alcance "own" se guarda como "all" (igual que al crear la iglesia).
          scope: p.supportsScope ? role.grants[p.key]! : 'all',
        })),
      ),
    });
    console.log(
      `✔ ${grants.map((p) => p.key).join(', ')} → rol ${role.systemKey} en ${roles.length} iglesia(s)`,
    );
  }
}
