import { resolvePermissions, type PermissionMap } from './resolve.js';

const TTL_MS = 60_000;
const cache = new Map<number, { value: PermissionMap; expiresAt: number }>();

/** Permisos efectivos del usuario, cacheados 60 s. Editar roles/asignaciones debe invalidar. */
export async function getPermissions(userId: number): Promise<PermissionMap> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await resolvePermissions(userId);
  cache.set(userId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidateUserPermissions(userId: number): void {
  cache.delete(userId);
}

/** Tras editar un rol: afecta a todos sus usuarios; con una sola instancia basta limpiar todo. */
export function invalidateAllPermissions(): void {
  cache.clear();
}
