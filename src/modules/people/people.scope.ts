import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma/client.js';
import { tenantDb } from '../../core/db/tenant.js';
import { authOf } from '../../core/middleware/authenticate.js';
import type { PermissionKey, PermissionScope } from '../../core/rbac/catalog.js';
import { getPermissions } from '../../core/rbac/permission-cache.js';
import type { PermissionMap } from '../../core/rbac/resolve.js';

/** Quién está mirando: permisos efectivos + su propia ficha de persona (si está vinculado). */
export interface Viewer {
  userId: number;
  personId: number | null;
  permissions: PermissionMap;
}

const viewers = new WeakMap<Request, Viewer>();

export async function viewerOf(req: Request): Promise<Viewer> {
  const cached = viewers.get(req);
  if (cached) return cached;
  const auth = authOf(req);
  auth.permissions ??= await getPermissions(auth.userId);
  const user = await tenantDb().user.findUnique({
    where: { id: auth.userId },
    select: { personId: true },
  });
  const viewer = { userId: auth.userId, personId: user?.personId ?? null, permissions: auth.permissions };
  viewers.set(req, viewer);
  return viewer;
}

export const scopeOf = (viewer: Viewer, key: PermissionKey): PermissionScope | undefined =>
  viewer.permissions[key];

/**
 * Personas "propias" de un usuario con alcance limitado.
 * Fase 2: las que cargó él y su propia ficha. Fase 3 suma integrantes de sus células/zonas/redes
 * y los casos de consolidación que tiene asignados.
 */
export function ownPeopleWhere(viewer: Viewer): Prisma.PersonWhereInput {
  return {
    OR: [{ createdById: viewer.userId }, ...(viewer.personId ? [{ id: viewer.personId }] : [])],
  };
}

/**
 * Filtro de personas visibles para un permiso: {} con alcance total, el filtro "propio" con
 * alcance limitado, o null si no tiene el permiso.
 */
export function peopleWhereFor(viewer: Viewer, key: PermissionKey): Prisma.PersonWhereInput | null {
  const scope = scopeOf(viewer, key);
  if (!scope) return null;
  return scope === 'all' ? {} : ownPeopleWhere(viewer);
}

/** ¿La persona (viva) entra en el alcance del permiso? */
export async function canOnPerson(viewer: Viewer, key: PermissionKey, personId: number): Promise<boolean> {
  const where = peopleWhereFor(viewer, key);
  if (!where) return false;
  if (Object.keys(where).length === 0) return true;
  const count = await tenantDb().person.count({ where: { AND: [{ id: personId, deletedAt: null }, where] } });
  return count > 0;
}
