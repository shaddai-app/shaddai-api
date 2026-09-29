import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import type { PermissionKey } from '../../core/rbac/catalog.js';
import { localToDate, nowLocalIn } from '../../core/time/local-date.js';
import { todayDate } from '../cells/cells.service.js';
import { isoDate } from '../people/people.service.js';
import { scopeOf, type Viewer } from '../people/people.scope.js';

// ───────────── Esquemas ─────────────

export const MINISTRY_KINDS = ['general', 'worship', 'tech', 'kids', 'ushers'] as const;
export const MEMBER_ROLES = ['leader', 'coleader', 'servant'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const MinistryFields = z.object({
  name: z.string().trim().min(1).max(100),
  description: optionalText(500),
  color: z
    .string()
    .regex(/^[a-z]+$/)
    .max(20)
    .nullable()
    .optional(),
  kind: z.enum(MINISTRY_KINDS),
  campusId: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const CreateMinistrySchema = MinistryFields.extend({
  kind: z.enum(MINISTRY_KINDS).default('general'),
  /** Crea los puestos habituales del tipo de ministerio (guitarra, sonido, recepción…). */
  withDefaultRoles: z.boolean().default(true),
  leaderPersonId: z.number().int().positive().nullable().optional(),
}).strict();
export const UpdateMinistrySchema = MinistryFields.partial().strict();

export const MemberSchema = z
  .object({ personId: z.number().int().positive(), role: z.enum(MEMBER_ROLES).default('servant') })
  .strict();
export const MemberRoleSchema = z.object({ role: z.enum(MEMBER_ROLES) }).strict();

export const RoleSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const UpdateRoleSchema = z
  .object({ name: z.string().trim().min(1).max(80), isActive: z.boolean() })
  .partial()
  .strict();
export const ReorderSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).strict();

export const ListQuery = z.object({ includeInactive: z.stringbool().default(false) });

type Locale = 'es' | 'en' | 'pt';

/** Puestos habituales por tipo de ministerio, en el idioma de la iglesia. */
const DEFAULT_ROLES: Record<(typeof MINISTRY_KINDS)[number], Record<Locale, string[]>> = {
  general: { es: [], en: [], pt: [] },
  worship: {
    es: [
      'Dirección',
      'Voz',
      'Coros',
      'Guitarra acústica',
      'Guitarra eléctrica',
      'Bajo',
      'Batería',
      'Teclado',
    ],
    en: [
      'Worship leader',
      'Vocals',
      'Backing vocals',
      'Acoustic guitar',
      'Electric guitar',
      'Bass',
      'Drums',
      'Keys',
    ],
    pt: ['Ministro', 'Voz', 'Backing vocal', 'Violão', 'Guitarra', 'Baixo', 'Bateria', 'Teclado'],
  },
  tech: {
    es: ['Sonido', 'Proyección', 'Transmisión', 'Luces'],
    en: ['Sound', 'Projection', 'Live stream', 'Lighting'],
    pt: ['Som', 'Projeção', 'Transmissão', 'Iluminação'],
  },
  kids: {
    es: ['Maestra/o', 'Asistente'],
    en: ['Teacher', 'Assistant'],
    pt: ['Professor(a)', 'Auxiliar'],
  },
  ushers: {
    es: ['Recepción', 'Ujier de sala', 'Estacionamiento'],
    en: ['Welcome', 'Usher', 'Parking'],
    pt: ['Recepção', 'Diácono de salão', 'Estacionamento'],
  },
};

// ───────────── Alcance ─────────────

/** Para ver: los ministerios que integra. Para gestionar y turnos: los que lidera o colidera. */
function ownWhere(viewer: Viewer, key: PermissionKey): Prisma.MinistryWhereInput {
  if (!viewer.personId) return { id: -1 };
  return {
    members: {
      some: {
        personId: viewer.personId,
        leftAt: null,
        ...(key === 'ministerios.ver' ? {} : { role: { in: ['leader', 'coleader'] } }),
      },
    },
  };
}

/** Filtro de ministerios (no borrados) para un permiso, o null sin permiso. */
export function ministryWhereFor(viewer: Viewer, key: PermissionKey): Prisma.MinistryWhereInput | null {
  const scope = scopeOf(viewer, key);
  if (!scope) return null;
  return { AND: [{ deletedAt: null }, scope === 'all' ? {} : ownWhere(viewer, key)] };
}

export async function ministryInScope(viewer: Viewer, key: PermissionKey, id: number) {
  const where = ministryWhereFor(viewer, key);
  if (!where) return false;
  return (await tenantDb().ministry.count({ where: { AND: [{ id }, where] } })) > 0;
}

async function visible(viewer: Viewer, id: number) {
  if (!(await ministryInScope(viewer, 'ministerios.ver', id))) throw AppError.notFound('MINISTRY_NOT_FOUND');
}

async function manageable(viewer: Viewer, id: number) {
  await visible(viewer, id);
  if (!(await ministryInScope(viewer, 'ministerios.gestionar', id))) {
    throw AppError.forbidden('MINISTRY_MANAGE_FORBIDDEN');
  }
}

/** Ahora en la hora local de la iglesia (como se guardan las fechas de los eventos). */
export async function accountNow() {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  return localToDate(nowLocalIn(timezone));
}

const managesAll = (viewer: Viewer) => scopeOf(viewer, 'ministerios.gestionar') === 'all';

/** Con alcance propio no se nombran ni se sacan líderes (lo hace quien gestiona todos). */
function assertLeaderChange(viewer: Viewer, role: string) {
  if (role === 'leader' && !managesAll(viewer)) throw AppError.forbidden('MINISTRY_LEADER_FORBIDDEN');
}

async function assertPerson(personId: number) {
  if (!(await tenantDb().person.count({ where: { id: personId, deletedAt: null } }))) {
    throw AppError.badRequest('PERSON_INVALID');
  }
}

async function assertCampus(campusId: number | null | undefined) {
  if (campusId && !(await tenantDb().campus.count({ where: { id: campusId } }))) {
    throw AppError.badRequest('CAMPUS_INVALID');
  }
}

// ───────────── Ministerios ─────────────

const personRef = { id: true, firstName: true, lastName: true, phone: true } as const;
const ROLE_ORDER: Record<string, number> = { leader: 0, coleader: 1, servant: 2 };
const byRole = (a: { role: string }, b: { role: string }) => ROLE_ORDER[a.role]! - ROLE_ORDER[b.role]!;

export async function listMinistries(viewer: Viewer, q: z.infer<typeof ListQuery>) {
  const scope = ministryWhereFor(viewer, 'ministerios.ver');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');
  const rows = await tenantDb().ministry.findMany({
    where: { AND: [scope, q.includeInactive ? {} : { isActive: true }] },
    select: {
      id: true,
      name: true,
      description: true,
      color: true,
      kind: true,
      isActive: true,
      campus: { select: { id: true, name: true } },
      members: { where: { leftAt: null }, select: { role: true, person: { select: personRef } } },
    },
    orderBy: { name: 'asc' },
  });
  return {
    items: rows.map(({ members, ...m }) => ({
      ...m,
      memberCount: members.length,
      leaders: members
        .filter((x) => x.role !== 'servant')
        .sort(byRole)
        .map((x) => ({ ...x.person, role: x.role })),
    })),
    canCreate: managesAll(viewer),
  };
}

export async function getMinistry(viewer: Viewer, id: number) {
  await visible(viewer, id);
  const m = await tenantDb().ministry.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      color: true,
      kind: true,
      isActive: true,
      createdAt: true,
      campus: { select: { id: true, name: true } },
      members: {
        where: { leftAt: null },
        select: { id: true, role: true, joinedAt: true, person: { select: personRef } },
      },
      roles: {
        select: { id: true, name: true, sortOrder: true, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      },
    },
  });
  const canManage = await ministryInScope(viewer, 'ministerios.gestionar', id);
  return {
    ...m,
    members: m.members
      .map((x) => ({ ...x, joinedAt: isoDate(x.joinedAt) }))
      .sort(
        (a, b) =>
          byRole(a, b) ||
          a.person.lastName.localeCompare(b.person.lastName) ||
          a.person.firstName.localeCompare(b.person.firstName),
      ),
    canManage,
    canManageLeaders: canManage && managesAll(viewer),
    canDelete: managesAll(viewer),
  };
}

export async function createMinistry(viewer: Viewer, input: z.infer<typeof CreateMinistrySchema>) {
  if (!managesAll(viewer)) throw AppError.forbidden('MINISTRY_CREATE_FORBIDDEN');
  await assertCampus(input.campusId);
  if (input.leaderPersonId) await assertPerson(input.leaderPersonId);
  const db = tenantDb();
  const accountId = currentAccountId();
  const { defaultLocale } = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { defaultLocale: true },
  });
  const locale: Locale = defaultLocale === 'en' || defaultLocale === 'pt' ? defaultLocale : 'es';
  const roles = input.withDefaultRoles ? DEFAULT_ROLES[input.kind][locale] : [];
  const today = await todayDate();
  const created = await db.ministry.create({
    data: {
      accountId,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? null,
      kind: input.kind,
      campusId: input.campusId ?? null,
      isActive: input.isActive ?? true,
      // Escritura anidada: los puestos y el líder son hijos del ministerio nuevo.
      roles: { create: roles.map((name, i) => ({ accountId, name, sortOrder: (i + 1) * 10 })) },
      ...(input.leaderPersonId
        ? {
            members: {
              create: { accountId, personId: input.leaderPersonId, role: 'leader', joinedAt: today },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  await audit({
    action: 'ministries.create',
    entity: 'Ministry',
    entityId: created.id,
    after: { name: input.name, kind: input.kind, roles: roles.length, leader: input.leaderPersonId ?? null },
  });
  return getMinistry(viewer, created.id);
}

export async function updateMinistry(
  viewer: Viewer,
  id: number,
  input: z.infer<typeof UpdateMinistrySchema>,
) {
  await manageable(viewer, id);
  await assertCampus(input.campusId);
  const db = tenantDb();
  const before = await db.ministry.findUniqueOrThrow({
    where: { id },
    select: { name: true, isActive: true },
  });
  await db.ministry.update({ where: { id }, data: input });
  await audit({ action: 'ministries.update', entity: 'Ministry', entityId: id, before, after: input });
  return getMinistry(viewer, id);
}

/** Borrado lógico: se conserva el historial de integrantes (y de turnos, más adelante). */
export async function deleteMinistry(viewer: Viewer, id: number) {
  await visible(viewer, id);
  if (!managesAll(viewer)) throw AppError.forbidden('MINISTRY_DELETE_FORBIDDEN');
  const db = tenantDb();
  const m = await db.ministry.findUniqueOrThrow({ where: { id }, select: { name: true } });
  await db.ministry.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
  await audit({ action: 'ministries.delete', entity: 'Ministry', entityId: id, before: m });
}

// ───────────── Integrantes ─────────────

async function activeMember(ministryId: number, memberId: number) {
  const member = await tenantDb().ministryMember.findFirst({
    where: { id: memberId, ministryId, leftAt: null },
    select: { id: true, role: true, personId: true },
  });
  if (!member) throw AppError.notFound('MEMBER_NOT_FOUND');
  return member;
}

export async function addMember(viewer: Viewer, id: number, input: z.infer<typeof MemberSchema>) {
  await manageable(viewer, id);
  assertLeaderChange(viewer, input.role);
  await assertPerson(input.personId);
  const db = tenantDb();
  if (await db.ministryMember.count({ where: { ministryId: id, personId: input.personId, leftAt: null } })) {
    throw AppError.conflict('MINISTRY_MEMBER_EXISTS');
  }
  await db.ministryMember.create({
    data: {
      accountId: currentAccountId(),
      ministryId: id,
      personId: input.personId,
      role: input.role,
      joinedAt: await todayDate(),
    },
  });
  await audit({ action: 'ministries.member.add', entity: 'Ministry', entityId: id, after: input });
  return getMinistry(viewer, id);
}

export async function updateMember(
  viewer: Viewer,
  id: number,
  memberId: number,
  input: z.infer<typeof MemberRoleSchema>,
) {
  await manageable(viewer, id);
  const member = await activeMember(id, memberId);
  // Nombrar líder o quitarle el rol a un líder es de quien gestiona todos los ministerios.
  assertLeaderChange(viewer, input.role);
  assertLeaderChange(viewer, member.role);
  await tenantDb().ministryMember.update({ where: { id: memberId }, data: { role: input.role } });
  await audit({
    action: 'ministries.member.role',
    entity: 'Ministry',
    entityId: id,
    before: { personId: member.personId, role: member.role },
    after: { role: input.role },
  });
  return getMinistry(viewer, id);
}

export async function removeMember(viewer: Viewer, id: number, memberId: number) {
  await manageable(viewer, id);
  const member = await activeMember(id, memberId);
  assertLeaderChange(viewer, member.role);
  const db = tenantDb();
  await db.ministryMember.update({ where: { id: memberId }, data: { leftAt: await todayDate() } });
  // Sus turnos futuros en este ministerio quedan sin efecto (los pasados son historial).
  const { count: dropped } = await db.serviceAssignment.deleteMany({
    where: { ministryId: id, personId: member.personId, occurrenceStart: { gte: await accountNow() } },
  });
  await audit({
    action: 'ministries.member.remove',
    entity: 'Ministry',
    entityId: id,
    before: { personId: member.personId, role: member.role },
    after: { droppedAssignments: dropped },
  });
  return getMinistry(viewer, id);
}

// ───────────── Puestos ─────────────

async function roleOf(ministryId: number, roleId: number) {
  const role = await tenantDb().serviceRole.findFirst({ where: { id: roleId, ministryId } });
  if (!role) throw AppError.notFound('SERVICE_ROLE_NOT_FOUND');
  return role;
}

export async function createRole(viewer: Viewer, id: number, input: z.infer<typeof RoleSchema>) {
  await manageable(viewer, id);
  const db = tenantDb();
  const last = await db.serviceRole.findFirst({
    where: { ministryId: id },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  await db.serviceRole.create({
    data: {
      accountId: currentAccountId(),
      ministryId: id,
      name: input.name,
      sortOrder: (last?.sortOrder ?? 0) + 10,
    },
  });
  await audit({ action: 'ministries.role.create', entity: 'Ministry', entityId: id, after: input });
  return getMinistry(viewer, id);
}

export async function updateRole(
  viewer: Viewer,
  id: number,
  roleId: number,
  input: z.infer<typeof UpdateRoleSchema>,
) {
  await manageable(viewer, id);
  const before = await roleOf(id, roleId);
  await tenantDb().serviceRole.update({ where: { id: roleId }, data: input });
  await audit({
    action: 'ministries.role.update',
    entity: 'Ministry',
    entityId: id,
    before: { roleId, name: before.name, isActive: before.isActive },
    after: input,
  });
  return getMinistry(viewer, id);
}

export async function reorderRoles(viewer: Viewer, id: number, ids: number[]) {
  await manageable(viewer, id);
  const db = tenantDb();
  const roles = await db.serviceRole.findMany({ where: { ministryId: id }, select: { id: true } });
  const known = new Set(roles.map((r) => r.id));
  if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((x) => known.has(x))) {
    throw AppError.badRequest('SERVICE_ROLE_ORDER_INVALID');
  }
  await db.$transaction(
    ids.map((roleId, i) =>
      db.serviceRole.update({ where: { id: roleId }, data: { sortOrder: (i + 1) * 10 } }),
    ),
  );
  return getMinistry(viewer, id);
}

export async function deleteRole(viewer: Viewer, id: number, roleId: number) {
  await manageable(viewer, id);
  const role = await roleOf(id, roleId);
  // Con turnos (aunque sean pasados) no se borra: se desactiva para conservar el historial.
  if (await tenantDb().serviceAssignment.count({ where: { serviceRoleId: roleId } })) {
    throw AppError.conflict('SERVICE_ROLE_IN_USE');
  }
  await tenantDb().serviceRole.delete({ where: { id: roleId } });
  await audit({
    action: 'ministries.role.delete',
    entity: 'Ministry',
    entityId: id,
    before: { name: role.name },
  });
  return getMinistry(viewer, id);
}
