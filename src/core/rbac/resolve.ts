import { prisma } from '../db/prisma.js';
import { PERMISSIONS, type PermissionKey, type PermissionScope } from './catalog.js';

export type PermissionMap = Partial<Record<PermissionKey, PermissionScope>>;

export const ADMIN_ROLE_KEY = 'admin';

/**
 * Permisos efectivos = unión de los roles del usuario; si un permiso aparece con "all" y "own", gana "all".
 * El rol Administrador (bloqueado) tiene siempre todos, incluso los que se agreguen al catálogo después.
 */
export async function resolvePermissions(userId: number): Promise<PermissionMap> {
  const roles = await prisma.userRole.findMany({
    where: { userId },
    select: {
      role: {
        select: {
          systemKey: true,
          isLocked: true,
          permissions: { select: { scope: true, permission: { select: { key: true } } } },
        },
      },
    },
  });

  const result: PermissionMap = {};
  if (roles.some(({ role }) => role.isLocked && role.systemKey === ADMIN_ROLE_KEY)) {
    for (const p of PERMISSIONS) result[p.key] = 'all';
    return result;
  }
  for (const { role } of roles) {
    for (const rp of role.permissions) {
      const key = rp.permission.key as PermissionKey;
      if (result[key] !== 'all') result[key] = rp.scope === 'all' ? 'all' : 'own';
    }
  }
  return result;
}
