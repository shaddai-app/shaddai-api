import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { distanceKm } from '../../core/geocoding/geocoding.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import type { PermissionKey } from '../../core/rbac/catalog.js';
import { dateOnly } from '../people/people.schemas.js';
import { fold, isoDate } from '../people/people.service.js';
import { canOnPerson, ownCellWhere, ownZoneWhere, scopeOf, type Viewer } from '../people/people.scope.js';

// ───────────── Esquemas ─────────────

export const CELL_STATUSES = ['active', 'paused', 'closed', 'multiplied'] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

const CellFields = z.object({
  name: z.string().trim().min(1).max(100),
  code: optionalText(20),
  zoneId: z.number().int().positive(),
  campusId: z.number().int().positive().nullable(),
  meetingDay: z.number().int().min(0).max(6),
  meetingTime: time,
  address: z.string().trim().min(1).max(250),
  city: optionalText(100),
  neighborhood: optionalText(100),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  leaderPersonId: z.number().int().positive(),
  coLeaderPersonId: z.number().int().positive().nullable(),
  hostPersonId: z.number().int().positive().nullable(),
  startedAt: dateOnly.nullable(),
});

export const CreateCellSchema = CellFields.partial()
  .required({
    name: true,
    zoneId: true,
    meetingDay: true,
    meetingTime: true,
    address: true,
    leaderPersonId: true,
  })
  .strict();

export const UpdateCellSchema = CellFields.partial()
  .extend({ status: z.enum(['active', 'paused', 'closed']).optional() })
  .strict();

export const ListCellsQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  zoneId: z.coerce.number().int().positive().optional(),
  networkId: z.coerce.number().int().positive().optional(),
  status: z.enum(CELL_STATUSES).optional(),
  meetingDay: z.coerce.number().int().min(0).max(6).optional(),
  /** Solo las que lidero, colidero o hospedo. */
  mine: z.stringbool().optional(),
});

// ───────────── Alcance ─────────────

/** Filtro de células para un permiso: {} (todas), propias, o null (sin permiso). */
export function cellWhereFor(viewer: Viewer, key: PermissionKey): Prisma.CellWhereInput | null {
  const scope = scopeOf(viewer, key);
  if (!scope) return null;
  return scope === 'all' ? {} : ownCellWhere(viewer);
}

/** Ids (de entre `ids`) que entran en el alcance del permiso. */
export async function idsInScope(viewer: Viewer, key: PermissionKey, ids: number[]): Promise<Set<number>> {
  const where = cellWhereFor(viewer, key);
  if (!where || ids.length === 0) return new Set();
  if (Object.keys(where).length === 0) return new Set(ids);
  const rows = await tenantDb().cell.findMany({
    where: { AND: [{ id: { in: ids } }, where] },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

export async function inScope(viewer: Viewer, key: PermissionKey, id: number) {
  return (await idsInScope(viewer, key, [id])).has(id);
}

// ───────────── Presentación ─────────────

const personRef = {
  select: { id: true, firstName: true, lastName: true, photoFileId: true, phone: true },
} as const;

const cellSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  meetingDay: true,
  meetingTime: true,
  address: true,
  city: true,
  neighborhood: true,
  lat: true,
  lng: true,
  startedAt: true,
  closedAt: true,
  createdAt: true,
  campus: { select: { id: true, name: true } },
  zone: { select: { id: true, name: true, network: { select: { id: true, name: true, color: true } } } },
  leader: personRef,
  coLeader: personRef,
  host: personRef,
  parentCell: { select: { id: true, name: true } },
  _count: { select: { members: { where: { leftAt: null } } } },
} as const;

type CellRow = Prisma.CellGetPayload<{ select: typeof cellSelect }>;

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/** Sin celulas.ver_direccion: sin calle ni coordenadas exactas (barrio y ciudad sí). */
function present(row: CellRow, showAddress: boolean) {
  const { address, lat, lng, _count, startedAt, closedAt, ...rest } = row;
  return {
    ...rest,
    startedAt: isoDate(startedAt),
    closedAt: isoDate(closedAt),
    memberCount: _count.members,
    ...(showAddress ? { address, lat: num(lat), lng: num(lng) } : {}),
  };
}

// ───────────── Validaciones ─────────────

/**
 * Las personas que se asignan (líder, integrantes) tienen que existir y, si el usuario tiene
 * alcance limitado de células, estar en su alcance de personas.
 */
async function assertPeople(viewer: Viewer, ids: (number | null | undefined)[], key: PermissionKey) {
  const strict = scopeOf(viewer, key) !== 'all';
  for (const id of new Set(ids.filter((v): v is number => typeof v === 'number'))) {
    const exists = await tenantDb().person.count({ where: { id, deletedAt: null } });
    if (!exists || (strict && !(await canOnPerson(viewer, 'personas.ver', id)))) {
      throw AppError.badRequest('PERSON_INVALID');
    }
  }
}

async function assertZone(viewer: Viewer, zoneId: number | undefined, key: PermissionKey) {
  if (!zoneId) return;
  const own = scopeOf(viewer, key) === 'own';
  const zone = await tenantDb().zone.findFirst({
    where: { AND: [{ id: zoneId }, own ? ownZoneWhere(viewer) : {}] },
  });
  if (!zone) throw AppError.badRequest('ZONE_INVALID');
}

async function assertCampus(id: number | null | undefined) {
  if (id && !(await tenantDb().campus.count({ where: { id } }))) throw AppError.badRequest('CAMPUS_INVALID');
}

// ───────────── Consultas ─────────────

export async function listCells(viewer: Viewer, query: z.infer<typeof ListCellsQuery>) {
  const scope = cellWhereFor(viewer, 'celulas.ver');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');
  const and: Prisma.CellWhereInput[] = [scope];
  and.push(query.status ? { status: query.status } : { status: { in: ['active', 'paused'] } });
  if (query.zoneId) and.push({ zoneId: query.zoneId });
  if (query.networkId) and.push({ zone: { networkId: query.networkId } });
  if (query.meetingDay !== undefined) and.push({ meetingDay: query.meetingDay });
  if (query.mine) {
    const p = viewer.personId ?? -1;
    and.push({ OR: [{ leaderPersonId: p }, { coLeaderPersonId: p }, { hostPersonId: p }] });
  }
  for (const token of (query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5)) {
    and.push({
      OR: [
        { name: { contains: token } },
        { code: { contains: token } },
        { neighborhood: { contains: token } },
        { leader: { searchText: { contains: fold(token) } } },
      ],
    });
  }
  const where: Prisma.CellWhereInput = { AND: and };
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.cell.findMany({ where, select: cellSelect, orderBy: [{ name: 'asc' }], ...toSkipTake(query) }),
    db.cell.count({ where }),
  ]);
  const withAddress = await idsInScope(
    viewer,
    'celulas.ver_direccion',
    rows.map((r) => r.id),
  );
  return paged(
    rows.map((r) => present(r, withAddress.has(r.id))),
    total,
    query,
  );
}

export async function getCell(viewer: Viewer, id: number) {
  if (!(await inScope(viewer, 'celulas.ver', id))) throw AppError.notFound('CELL_NOT_FOUND');
  const db = tenantDb();
  const row = await db.cell.findUnique({ where: { id }, select: cellSelect });
  if (!row) throw AppError.notFound('CELL_NOT_FOUND');
  const [members, children, access] = await Promise.all([
    db.cellMember.findMany({
      where: { cellId: id, leftAt: null, person: { deletedAt: null } },
      select: {
        joinedAt: true,
        person: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            photoFileId: true,
            phone: true,
            birthDate: true,
            status: { select: { id: true, systemKey: true, name: true, color: true } },
          },
        },
      },
      orderBy: [{ person: { lastName: 'asc' } }, { person: { firstName: 'asc' } }],
    }),
    db.cell.findMany({ where: { parentCellId: id }, select: { id: true, name: true, status: true } }),
    Promise.all([
      inScope(viewer, 'celulas.editar', id),
      inScope(viewer, 'celulas.ver_direccion', id),
      inScope(viewer, 'celulas.reportar', id),
      inScope(viewer, 'celulas.multiplicar', id),
    ]),
  ]);
  const [edit, address, report, multiply] = access;
  return {
    ...present(row, address),
    members: members.map(({ joinedAt, person: { birthDate, ...p } }) => ({
      ...p,
      birthDate: isoDate(birthDate),
      joinedAt: isoDate(joinedAt),
    })),
    children,
    access: { edit, address, report, multiply, close: Boolean(scopeOf(viewer, 'celulas.eliminar')) },
  };
}

// ───────────── Alta / edición / cierre ─────────────

export async function createCell(viewer: Viewer, input: z.infer<typeof CreateCellSchema>) {
  await assertZone(viewer, input.zoneId, 'celulas.crear');
  await assertCampus(input.campusId);
  await assertPeople(
    viewer,
    [input.leaderPersonId, input.coLeaderPersonId, input.hostPersonId],
    'celulas.crear',
  );
  const db = tenantDb();
  const cell = await db.$transaction(async (tx) => {
    const created = await tx.cell.create({
      data: { ...input, accountId: currentAccountId(), startedAt: input.startedAt ?? todayDate() },
      select: { id: true },
    });
    // El líder (y colíder/anfitrión) quedan como integrantes de su célula.
    const people = [input.leaderPersonId, input.coLeaderPersonId, input.hostPersonId].filter(
      (v): v is number => typeof v === 'number',
    );
    for (const personId of new Set(people)) {
      const active = await tx.cellMember.findFirst({ where: { personId, leftAt: null } });
      if (!active) {
        await tx.cellMember.create({
          data: { accountId: currentAccountId(), cellId: created.id, personId, joinedAt: todayDate() },
        });
      }
    }
    return created;
  });
  await audit({
    action: 'cells.create',
    entity: 'Cell',
    entityId: cell.id,
    after: { name: input.name, zoneId: input.zoneId },
  });
  return getCell(viewer, cell.id);
}

export const todayDate = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

export async function updateCell(viewer: Viewer, id: number, input: z.infer<typeof UpdateCellSchema>) {
  if (!(await inScope(viewer, 'celulas.ver', id))) throw AppError.notFound('CELL_NOT_FOUND');
  if (!(await inScope(viewer, 'celulas.editar', id))) throw AppError.forbidden('CELL_EDIT_FORBIDDEN');
  const touchesAddress = ['address', 'lat', 'lng'].some((k) => k in input);
  if (touchesAddress && !(await inScope(viewer, 'celulas.ver_direccion', id))) {
    throw AppError.forbidden('CELL_ADDRESS_FORBIDDEN');
  }
  // Cambiar de zona con alcance propio: solo a otra zona propia.
  await assertZone(viewer, input.zoneId, 'celulas.editar');
  await assertCampus(input.campusId);
  await assertPeople(
    viewer,
    [input.leaderPersonId, input.coLeaderPersonId, input.hostPersonId],
    'celulas.editar',
  );

  const db = tenantDb();
  const before = await db.cell.findUniqueOrThrow({ where: { id } });
  if (before.status === 'closed' || before.status === 'multiplied') {
    if (input.status !== 'active') throw AppError.conflict('CELL_CLOSED');
  }
  const closing = input.status === 'closed' && before.status !== 'closed';
  await db.$transaction(async (tx) => {
    await tx.cell.update({
      where: { id },
      data: {
        ...input,
        ...(closing ? { closedAt: todayDate() } : {}),
        ...(input.status === 'active' ? { closedAt: null } : {}),
      },
    });
    if (closing)
      await tx.cellMember.updateMany({ where: { cellId: id, leftAt: null }, data: { leftAt: todayDate() } });
  });
  await audit({
    action: closing ? 'cells.close' : 'cells.update',
    entity: 'Cell',
    entityId: id,
    before: { status: before.status, leaderPersonId: before.leaderPersonId, zoneId: before.zoneId },
    after: input,
  });
  return getCell(viewer, id);
}

// ───────────── Integrantes ─────────────

export async function addMember(viewer: Viewer, cellId: number, personId: number, move: boolean) {
  if (!(await inScope(viewer, 'celulas.ver', cellId))) throw AppError.notFound('CELL_NOT_FOUND');
  if (!(await inScope(viewer, 'celulas.editar', cellId))) throw AppError.forbidden('CELL_EDIT_FORBIDDEN');
  await assertPeople(viewer, [personId], 'celulas.editar');
  const db = tenantDb();
  const cell = await db.cell.findUniqueOrThrow({ where: { id: cellId }, select: { status: true } });
  if (!['active', 'paused'].includes(cell.status)) throw AppError.conflict('CELL_CLOSED');

  const current = await db.cellMember.findFirst({
    where: { personId, leftAt: null },
    include: { cell: { select: { id: true, name: true } } },
  });
  if (current?.cellId === cellId) return getCell(viewer, cellId);
  // Una persona participa en una sola célula a la vez: moverla requiere confirmación.
  if (current && !move) {
    throw AppError.conflict('PERSON_IN_OTHER_CELL', { cellId: current.cell.id, cellName: current.cell.name });
  }
  await db.$transaction(async (tx) => {
    if (current) await tx.cellMember.update({ where: { id: current.id }, data: { leftAt: todayDate() } });
    await tx.cellMember.create({
      data: { accountId: currentAccountId(), cellId, personId, joinedAt: todayDate() },
    });
  });
  await audit({
    action: 'cells.member.add',
    entity: 'Cell',
    entityId: cellId,
    after: { personId, movedFrom: current?.cellId ?? null },
  });
  return getCell(viewer, cellId);
}

export async function removeMember(viewer: Viewer, cellId: number, personId: number) {
  if (!(await inScope(viewer, 'celulas.ver', cellId))) throw AppError.notFound('CELL_NOT_FOUND');
  if (!(await inScope(viewer, 'celulas.editar', cellId))) throw AppError.forbidden('CELL_EDIT_FORBIDDEN');
  const db = tenantDb();
  const cell = await db.cell.findUniqueOrThrow({ where: { id: cellId } });
  if (cell.leaderPersonId === personId) throw AppError.conflict('CELL_LEADER_REQUIRED');
  const { count } = await db.cellMember.updateMany({
    where: { cellId, personId, leftAt: null },
    data: { leftAt: todayDate() },
  });
  if (count === 0) throw AppError.notFound('MEMBER_NOT_FOUND');
  await audit({ action: 'cells.member.remove', entity: 'Cell', entityId: cellId, after: { personId } });
  return getCell(viewer, cellId);
}

// ───────────── Mapa y célula más cercana ─────────────

/** Sin permiso de dirección, el punto se redondea (~1 km) para no revelar la casa. */
const blur = (v: number) => Math.round(v * 100) / 100;

export async function cellsMap(viewer: Viewer, filters: { zoneId?: number; networkId?: number }) {
  const scope = cellWhereFor(viewer, 'celulas.ver');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');
  const rows = await tenantDb().cell.findMany({
    where: {
      AND: [
        scope,
        { status: { in: ['active', 'paused'] }, lat: { not: null }, lng: { not: null } },
        ...(filters.zoneId ? [{ zoneId: filters.zoneId }] : []),
        ...(filters.networkId ? [{ zone: { networkId: filters.networkId } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      status: true,
      meetingDay: true,
      meetingTime: true,
      neighborhood: true,
      lat: true,
      lng: true,
      zone: { select: { id: true, name: true, network: { select: { id: true, name: true, color: true } } } },
      leader: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  const exact = await idsInScope(
    viewer,
    'celulas.ver_direccion',
    rows.map((r) => r.id),
  );
  return {
    items: rows.map(({ lat, lng, ...r }) => {
      const precise = exact.has(r.id);
      return {
        ...r,
        lat: precise ? Number(lat) : blur(Number(lat)),
        lng: precise ? Number(lng) : blur(Number(lng)),
        approximate: !precise,
      };
    }),
  };
}

/**
 * Células activas más cercanas a un punto (para derivar a alguien nuevo). Se buscan entre TODAS las
 * células de la iglesia, pero solo se devuelven datos públicos: nombre, barrio, líder, día y horario.
 */
export async function nearestCells(
  viewer: Viewer,
  query: { lat?: number; lng?: number; personId?: number; limit: number },
) {
  let origin: { lat: number; lng: number } | null =
    query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : null;
  if (!origin && query.personId) {
    // Las coordenadas de una persona son dato sensible.
    if (!(await canOnPerson(viewer, 'personas.ver_sensibles', query.personId))) {
      throw AppError.forbidden('SENSITIVE_FIELDS_FORBIDDEN');
    }
    const p = await tenantDb().person.findUnique({
      where: { id: query.personId },
      select: { lat: true, lng: true },
    });
    if (p?.lat !== null && p?.lat !== undefined && p.lng !== null)
      origin = { lat: Number(p.lat), lng: Number(p.lng) };
  }
  if (!origin) throw AppError.badRequest('LOCATION_REQUIRED');

  const cells = await tenantDb().cell.findMany({
    where: { status: 'active', lat: { not: null }, lng: { not: null } },
    select: {
      id: true,
      name: true,
      meetingDay: true,
      meetingTime: true,
      neighborhood: true,
      city: true,
      lat: true,
      lng: true,
      leader: { select: { id: true, firstName: true, lastName: true, phone: true } },
      zone: { select: { name: true, network: { select: { name: true } } } },
    },
  });
  const o = origin;
  return {
    items: cells
      .map(({ lat, lng, ...c }) => ({
        ...c,
        distanceKm: distanceKm(o, { lat: Number(lat), lng: Number(lng) }),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, query.limit)
      .map((c) => ({ ...c, distanceKm: Math.round(c.distanceKm * 10) / 10 })),
  };
}
