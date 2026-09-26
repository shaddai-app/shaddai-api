import type { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PERMISSIONS, type PermissionKey, type PermissionScope } from '../../core/rbac/catalog.js';
import { invalidateAllPermissions } from '../../core/rbac/permission-cache.js';
import type { CreateRoleSchema, MatrixSchema, UpdateRoleSchema } from './roles.schemas.js';

type Grants = Partial<Record<PermissionKey, PermissionScope>>;

const byKey = new Map(PERMISSIONS.map((p) => [p.key as string, p]));

/** Catálogo agrupado por módulo, en el orden del catálogo (para la matriz del front). */
export function permissionCatalog() {
  const modules = new Map<string, { key: string; action: string; supportsScope: boolean }[]>();
  for (const p of PERMISSIONS) {
    if (!modules.has(p.module)) modules.set(p.module, []);
    modules.get(p.module)!.push({ key: p.key, action: p.action, supportsScope: p.supportsScope });
  }
  return [...modules].map(([module, permissions]) => ({ module, permissions }));
}

/** Valida claves y alcances: "own" solo en permisos que lo admiten. */
function validateGrants(grants: Record<string, PermissionScope>): Grants {
  for (const [key, scope] of Object.entries(grants)) {
    const def = byKey.get(key);
    if (!def) throw AppError.badRequest('PERMISSION_UNKNOWN', { key });
    if (scope === 'own' && !def.supportsScope) throw AppError.badRequest('SCOPE_NOT_SUPPORTED', { key });
  }
  return grants as Grants;
}

async function permissionIdMap() {
  const rows = await tenantDb().permission.findMany({ select: { id: true, key: true } });
  return new Map(rows.map((r) => [r.key, r.id]));
}

const roleInclude = {
  permissions: { select: { scope: true, permission: { select: { key: true } } } },
  _count: { select: { users: true } },
} as const;

type RoleRow = Awaited<ReturnType<typeof findRole>>;

async function findRole(id: number) {
  const role = await tenantDb().role.findUnique({ where: { id }, include: roleInclude });
  if (!role) throw AppError.notFound('ROLE_NOT_FOUND');
  return role;
}

function present(role: RoleRow) {
  const { permissions, _count, accountId: _accountId, ...rest } = role;
  const grants: Grants = role.isLocked
    ? Object.fromEntries(PERMISSIONS.map((p) => [p.key, 'all']))
    : Object.fromEntries(permissions.map((p) => [p.permission.key, p.scope as PermissionScope]));
  return { ...rest, userCount: _count.users, grants };
}

export async function listRoles() {
  const roles = await tenantDb().role.findMany({
    include: roleInclude,
    orderBy: [{ isLocked: 'desc' }, { name: 'asc' }],
  });
  return roles.map(present);
}

export async function getRole(id: number) {
  return present(await findRole(id));
}

async function writeGrants(roleId: number, grants: Grants) {
  const ids = await permissionIdMap();
  const db = tenantDb();
  await db.$transaction([
    db.rolePermission.deleteMany({ where: { roleId } }),
    db.rolePermission.createMany({
      data: Object.entries(grants).map(([key, scope]) => ({
        roleId,
        permissionId: ids.get(key)!,
        scope: scope!,
      })),
    }),
  ]);
}

function assertEditable(role: { isLocked: boolean }) {
  if (role.isLocked) throw AppError.forbidden('ROLE_LOCKED');
}

export async function createRole(input: z.infer<typeof CreateRoleSchema>) {
  const grants = validateGrants(input.grants);
  const role = await tenantDb().role.create({
    data: { accountId: currentAccountId(), name: input.name, description: input.description ?? null },
  });
  await writeGrants(role.id, grants);
  invalidateAllPermissions();
  await audit({
    action: 'roles.create',
    entity: 'Role',
    entityId: role.id,
    after: { name: role.name, grants },
  });
  return getRole(role.id);
}

export async function updateRole(id: number, input: z.infer<typeof UpdateRoleSchema>) {
  const before = await findRole(id);
  assertEditable(before);
  const db = tenantDb();
  if (input.name !== undefined || input.description !== undefined) {
    await db.role.update({ where: { id }, data: { name: input.name, description: input.description } });
  }
  if (input.grants) await writeGrants(id, validateGrants(input.grants));
  invalidateAllPermissions();
  const after = await getRole(id);
  await audit({
    action: 'roles.update',
    entity: 'Role',
    entityId: id,
    before: present(before),
    after,
  });
  return after;
}

export async function deleteRole(id: number) {
  const role = await findRole(id);
  assertEditable(role);
  if (role._count.users > 0) throw AppError.conflict('ROLE_IN_USE', { userCount: role._count.users });
  const db = tenantDb();
  await db.$transaction([
    db.rolePermission.deleteMany({ where: { roleId: id } }),
    db.role.delete({ where: { id } }),
  ]);
  invalidateAllPermissions();
  await audit({ action: 'roles.delete', entity: 'Role', entityId: id, before: present(role) });
}

export async function getMatrix() {
  const roles = await listRoles();
  return {
    modules: permissionCatalog(),
    roles: roles.map(({ grants, ...r }) => ({ ...r, grants })),
  };
}

/** Guarda la matriz completa de una vez (una transacción por rol modificado). Los roles bloqueados no se tocan. */
export async function saveMatrix(input: z.infer<typeof MatrixSchema>) {
  const roleIds = Object.keys(input.grants).map(Number);
  const roles = await tenantDb().role.findMany({
    where: { id: { in: roleIds } },
    select: { id: true, isLocked: true },
  });
  if (roles.length !== roleIds.length) throw AppError.badRequest('ROLE_INVALID');
  if (roles.some((r) => r.isLocked)) throw AppError.forbidden('ROLE_LOCKED');

  const before = await getMatrix();
  for (const [roleId, grants] of Object.entries(input.grants)) {
    await writeGrants(Number(roleId), validateGrants(grants));
  }
  invalidateAllPermissions();
  const after = await getMatrix();
  const pick = (m: typeof before) =>
    Object.fromEntries(m.roles.filter((r) => roleIds.includes(r.id)).map((r) => [r.id, r.grants]));
  await audit({ action: 'roles.matrix.update', entity: 'Role', before: pick(before), after: pick(after) });
  return after;
}
