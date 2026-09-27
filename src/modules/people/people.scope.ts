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
 * Células "propias": donde es líder, colíder o anfitrión, las de las zonas que supervisa y las de
 * las redes que lidera. Sin ficha de persona vinculada no tiene células propias.
 */
export function ownCellWhere(viewer: Viewer): Prisma.CellWhereInput {
  const p = viewer.personId;
  if (!p) return { id: -1 };
  return {
    OR: [
      { leaderPersonId: p },
      { coLeaderPersonId: p },
      { hostPersonId: p },
      { zone: { supervisorPersonId: p } },
      { zone: { network: { leaderPersonId: p } } },
    ],
  };
}

/** Zonas propias: las que supervisa y las de sus redes (para crear células y filtrar). */
export function ownZoneWhere(viewer: Viewer): Prisma.ZoneWhereInput {
  const p = viewer.personId;
  if (!p) return { id: -1 };
  return { OR: [{ supervisorPersonId: p }, { network: { leaderPersonId: p } }] };
}

/**
 * Personas "propias" de un usuario con alcance limitado: las que cargó, su propia ficha, los
 * integrantes activos y líderes de sus células (ver ownCellWhere). Consolidación (casos asignados)
 * se suma en su tramo.
 */
export function ownPeopleWhere(viewer: Viewer): Prisma.PersonWhereInput {
  const cells = ownCellWhere(viewer);
  return {
    OR: [
      { createdById: viewer.userId },
      // Personas con un caso de consolidación asignado al usuario.
      { consolidationCases: { some: { consolidatorUserId: viewer.userId } } },
      ...(viewer.personId
        ? [
            { id: viewer.personId },
            { cellMemberships: { some: { leftAt: null, cell: cells } } },
            { leadsCells: { some: cells } },
            { coLeadsCells: { some: cells } },
            { hostsCells: { some: cells } },
          ]
        : []),
    ],
  };
}

/**
 * Casos de consolidación "propios": los asignados al usuario y los de personas de su alcance
 * (integrantes de sus células, las que cargó).
 */
export function ownCaseWhere(viewer: Viewer): Prisma.ConsolidationCaseWhereInput {
  return { OR: [{ consolidatorUserId: viewer.userId }, { person: ownPeopleWhere(viewer) }] };
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
