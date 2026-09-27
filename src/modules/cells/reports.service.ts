import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import {
  addDays,
  daysBetween,
  meetingDateInWeek,
  toDate,
  todayIn,
  toIso,
  weekStart,
} from '../../core/time/local-date.js';
import { fold, insertPerson, isoDate, normalizePhone } from '../people/people.service.js';
import { ownZoneWhere, scopeOf, type Viewer } from '../people/people.scope.js';
import { openCase } from '../consolidation/consolidation.service.js';
import { cellWhereFor, idsInScope, inScope } from './cells.service.js';

/** Días de tolerancia después de la reunión antes de marcar el reporte como faltante (rojo). */
export const REPORT_GRACE_DAYS = 2;

// ───────────── Esquemas ─────────────

const isoDateStr = z.iso.date();
const ids = z.array(z.number().int().positive()).max(200);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const ReportFields = z.object({
  meetingDate: isoDateStr,
  held: z.boolean(),
  notHeldReason: optionalText(300),
  topic: optionalText(200),
  anonymousVisitors: z.number().int().min(0).max(500).default(0),
  childrenCount: z.number().int().min(0).max(500).default(0),
  offeringAmount: z.number().min(0).max(100_000_000).nullable().optional(),
  notes: optionalText(1000),
  /** Integrantes presentes. */
  attendance: ids.default([]),
  /** Visitas que ya tienen ficha. */
  visitors: ids.default([]),
  /** Visitas nuevas: se crean como personas (origen «célula», estado inicial). */
  newVisitors: z
    .array(
      z.object({
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        phone: optionalText(30),
      }),
    )
    .max(30)
    .default([]),
});

export const CreateReportSchema = ReportFields.strict();
export const UpdateReportSchema = ReportFields.partial().strict();

export const ListReportsQuery = PaginationQuery.extend({
  from: isoDateStr.optional(),
  to: isoDateStr.optional(),
  zoneId: z.coerce.number().int().positive().optional(),
  networkId: z.coerce.number().int().positive().optional(),
});

export const MultiplySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    zoneId: z.number().int().positive().optional(),
    meetingDay: z.number().int().min(0).max(6),
    meetingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    address: z.string().trim().min(1).max(250),
    city: optionalText(100),
    neighborhood: optionalText(100),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    leaderPersonId: z.number().int().positive(),
    coLeaderPersonId: z.number().int().positive().nullable().optional(),
    hostPersonId: z.number().int().positive().nullable().optional(),
    /** Integrantes de la célula madre que pasan a la nueva. */
    memberIds: ids.default([]),
    date: isoDateStr.optional(),
    notes: optionalText(500),
  })
  .strict();

// ───────────── Helpers ─────────────

async function accountClock() {
  const account = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true, weekStartsOn: true, cellReportEditDays: true, cellMultiplyTarget: true },
  });
  return { ...account, today: todayIn(account.timezone) };
}

const reportSelect = {
  id: true,
  cellId: true,
  meetingDate: true,
  held: true,
  notHeldReason: true,
  topic: true,
  anonymousVisitors: true,
  childrenCount: true,
  offeringAmount: true,
  notes: true,
  submittedById: true,
  submittedAt: true,
  updatedAt: true,
  cell: { select: { id: true, name: true, zone: { select: { id: true, name: true } } } },
  attendance: {
    select: {
      isVisitor: true,
      person: { select: { id: true, firstName: true, lastName: true, photoFileId: true } },
    },
  },
} as const;

type ReportRow = Prisma.CellReportGetPayload<{ select: typeof reportSelect }>;

function present(r: ReportRow, withPeople: boolean) {
  const { attendance, meetingDate, offeringAmount, ...rest } = r;
  const members = attendance.filter((a) => !a.isVisitor);
  const visitors = attendance.filter((a) => a.isVisitor);
  return {
    ...rest,
    meetingDate: isoDate(meetingDate)!,
    offeringAmount: offeringAmount === null ? null : Number(offeringAmount),
    totals: {
      members: members.length,
      visitors: visitors.length + r.anonymousVisitors,
      children: r.childrenCount,
      total: attendance.length + r.anonymousVisitors + r.childrenCount,
    },
    ...(withPeople
      ? { attendance: members.map((a) => a.person), visitors: visitors.map((a) => a.person) }
      : {}),
  };
}

/** Con alcance "propio" solo se carga o corrige dentro de la ventana de días de la cuenta. */
function assertWindow(viewer: Viewer, meetingDate: string, clock: Awaited<ReturnType<typeof accountClock>>) {
  if (meetingDate > clock.today) throw AppError.badRequest('DATE_IN_FUTURE');
  if (
    scopeOf(viewer, 'celulas.reportar') !== 'all' &&
    daysBetween(meetingDate, clock.today) > clock.cellReportEditDays
  ) {
    throw AppError.conflict('REPORT_WINDOW_CLOSED', { days: clock.cellReportEditDays });
  }
}

async function assertCanReport(viewer: Viewer, cellId: number) {
  if (
    !(await inScope(viewer, 'celulas.ver', cellId)) &&
    !(await inScope(viewer, 'celulas.reportar', cellId))
  ) {
    throw AppError.notFound('CELL_NOT_FOUND');
  }
  if (!(await inScope(viewer, 'celulas.reportar', cellId))) throw AppError.forbidden('REPORT_FORBIDDEN');
}

/**
 * Arma la lista de asistencia: integrantes activos presentes + visitas con ficha + visitas nuevas
 * (se crean personas; si ya existe una ficha con el mismo teléfono se reutiliza).
 */
async function buildAttendance(
  viewer: Viewer,
  cellId: number,
  input: {
    held?: boolean;
    attendance?: number[];
    visitors?: number[];
    newVisitors?: { firstName: string; lastName: string; phone?: string | null }[];
  },
) {
  if (input.held === false) {
    if (input.attendance?.length || input.visitors?.length || input.newVisitors?.length) {
      throw AppError.badRequest('REPORT_NOT_HELD_WITH_ATTENDANCE');
    }
    return [];
  }
  const db = tenantDb();
  const members = new Set(
    (await db.cellMember.findMany({ where: { cellId, leftAt: null }, select: { personId: true } })).map(
      (m) => m.personId,
    ),
  );
  const present = [...new Set(input.attendance ?? [])];
  if (present.some((id) => !members.has(id))) throw AppError.badRequest('ATTENDANCE_INVALID');

  const visitorIds = [...new Set(input.visitors ?? [])].filter((id) => !members.has(id));
  if (visitorIds.length) {
    const found = await db.person.count({ where: { id: { in: visitorIds }, deletedAt: null } });
    if (found !== visitorIds.length) throw AppError.badRequest('PERSON_INVALID');
  }
  for (const v of input.newVisitors ?? []) {
    // Si ya hay una ficha con el mismo teléfono y nombre se reutiliza aunque el líder no la vea
    // (evita duplicados; el líder solo "conoce" el nombre que él mismo escribió).
    const phone = normalizePhone(v.phone);
    const candidates = phone
      ? await db.person.findMany({ where: { phone, deletedAt: null }, select: { id: true, firstName: true } })
      : [];
    const existing = candidates.find((p) => fold(p.firstName) === fold(v.firstName));
    let id = existing?.id;
    if (!id) {
      id = await insertPerson(
        viewer,
        { firstName: v.firstName, lastName: v.lastName, phone: v.phone ?? null, allowDuplicate: true },
        { source: 'cell' },
      );
      // Visita nueva de una célula → entra a consolidación (el caso aparece sin consolidador).
      await openCase({ personId: id, source: 'cell', createdById: viewer.userId });
    }
    if (!members.has(id) && !visitorIds.includes(id)) visitorIds.push(id);
  }
  return [
    ...present.map((personId) => ({ personId, isVisitor: false })),
    ...visitorIds.map((personId) => ({ personId, isVisitor: true })),
  ];
}

async function findReport(viewer: Viewer, id: number, key: 'celulas.ver_reportes' | 'celulas.reportar') {
  const report = await tenantDb().cellReport.findUnique({ where: { id }, select: reportSelect });
  if (!report) throw AppError.notFound('REPORT_NOT_FOUND');
  const canRead =
    (await inScope(viewer, 'celulas.ver_reportes', report.cellId)) ||
    (await inScope(viewer, 'celulas.reportar', report.cellId));
  if (!canRead) throw AppError.notFound('REPORT_NOT_FOUND');
  if (key === 'celulas.reportar' && !(await inScope(viewer, 'celulas.reportar', report.cellId))) {
    throw AppError.forbidden('REPORT_FORBIDDEN');
  }
  return report;
}

// ───────────── Reportes ─────────────

export async function createReport(
  viewer: Viewer,
  cellId: number,
  input: z.infer<typeof CreateReportSchema>,
) {
  await assertCanReport(viewer, cellId);
  const db = tenantDb();
  const cell = await db.cell.findUniqueOrThrow({ where: { id: cellId }, select: { status: true } });
  if (!['active', 'paused'].includes(cell.status)) throw AppError.conflict('CELL_CLOSED');
  const clock = await accountClock();
  assertWindow(viewer, input.meetingDate, clock);
  if (!input.held && !input.notHeldReason) throw AppError.badRequest('NOT_HELD_REASON_REQUIRED');

  const existing = await db.cellReport.findFirst({
    where: { cellId, meetingDate: toDate(input.meetingDate) },
    select: { id: true },
  });
  if (existing) throw AppError.conflict('REPORT_EXISTS', { reportId: existing.id });

  const attendance = await buildAttendance(viewer, cellId, input);
  const { attendance: _a, visitors: _v, newVisitors: _n, meetingDate, ...fields } = input;
  const report = await db.cellReport.create({
    data: {
      ...fields,
      accountId: currentAccountId(),
      cellId,
      meetingDate: toDate(meetingDate),
      submittedById: viewer.userId,
      // Escritura anidada: ver createPerson (chequeo de padres fuera de la transacción).
      attendance: { create: attendance },
    },
    select: { id: true },
  });
  await audit({
    action: 'cells.report.create',
    entity: 'CellReport',
    entityId: report.id,
    after: { cellId, meetingDate, held: input.held, attendance: attendance.length },
  });
  return getReport(viewer, report.id);
}

export async function getReport(viewer: Viewer, id: number) {
  const report = await findReport(viewer, id, 'celulas.ver_reportes');
  const clock = await accountClock();
  const editable =
    (await inScope(viewer, 'celulas.reportar', report.cellId)) &&
    (scopeOf(viewer, 'celulas.reportar') === 'all' ||
      daysBetween(isoDate(report.meetingDate)!, clock.today) <= clock.cellReportEditDays);
  return { ...present(report, true), access: { edit: editable } };
}

export async function updateReport(viewer: Viewer, id: number, input: z.infer<typeof UpdateReportSchema>) {
  const report = await findReport(viewer, id, 'celulas.reportar');
  const clock = await accountClock();
  assertWindow(viewer, isoDate(report.meetingDate)!, clock);
  if (input.meetingDate) {
    assertWindow(viewer, input.meetingDate, clock);
    const clash = await tenantDb().cellReport.findFirst({
      where: { cellId: report.cellId, meetingDate: toDate(input.meetingDate), id: { not: id } },
    });
    if (clash) throw AppError.conflict('REPORT_EXISTS', { reportId: clash.id });
  }
  const held = input.held ?? report.held;
  if (!held && !(input.notHeldReason ?? report.notHeldReason))
    throw AppError.badRequest('NOT_HELD_REASON_REQUIRED');

  const replaceAttendance =
    input.attendance !== undefined ||
    input.visitors !== undefined ||
    input.newVisitors !== undefined ||
    input.held === false;
  const attendance = replaceAttendance
    ? await buildAttendance(viewer, report.cellId, {
        held,
        attendance:
          input.attendance ??
          (held ? report.attendance.filter((a) => !a.isVisitor).map((a) => a.person.id) : []),
        visitors:
          input.visitors ??
          (held ? report.attendance.filter((a) => a.isVisitor).map((a) => a.person.id) : []),
        newVisitors: input.newVisitors,
      })
    : null;
  const { attendance: _a, visitors: _v, newVisitors: _n, meetingDate, ...fields } = input;
  await tenantDb().cellReport.update({
    where: { id },
    data: {
      ...fields,
      ...(meetingDate ? { meetingDate: toDate(meetingDate) } : {}),
      ...(held ? {} : { notHeldReason: fields.notHeldReason ?? report.notHeldReason }),
      ...(attendance ? { attendance: { deleteMany: {}, create: attendance } } : {}),
    },
  });
  await audit({
    action: 'cells.report.update',
    entity: 'CellReport',
    entityId: id,
    after: { changed: Object.keys(input) },
  });
  return getReport(viewer, id);
}

export async function deleteReport(viewer: Viewer, id: number) {
  const report = await findReport(viewer, id, 'celulas.reportar');
  assertWindow(viewer, isoDate(report.meetingDate)!, await accountClock());
  await tenantDb().cellReport.delete({ where: { id } });
  await audit({
    action: 'cells.report.delete',
    entity: 'CellReport',
    entityId: id,
    before: { cellId: report.cellId, meetingDate: isoDate(report.meetingDate) },
  });
}

/** Reportes visibles (por célula o por período), del más reciente al más viejo. */
export async function listReports(
  viewer: Viewer,
  query: z.infer<typeof ListReportsQuery> & { cellId?: number },
) {
  const scope = cellWhereFor(viewer, 'celulas.ver_reportes');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');
  if (query.cellId && !(await inScope(viewer, 'celulas.ver_reportes', query.cellId))) {
    throw AppError.notFound('CELL_NOT_FOUND');
  }
  const where: Prisma.CellReportWhereInput = {
    AND: [
      { cell: scope },
      ...(query.cellId ? [{ cellId: query.cellId }] : []),
      ...(query.zoneId ? [{ cell: { zoneId: query.zoneId } }] : []),
      ...(query.networkId ? [{ cell: { zone: { networkId: query.networkId } } }] : []),
      ...(query.from ? [{ meetingDate: { gte: toDate(query.from) } }] : []),
      ...(query.to ? [{ meetingDate: { lte: toDate(query.to) } }] : []),
    ],
  };
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.cellReport.findMany({
      where,
      select: reportSelect,
      orderBy: [{ meetingDate: 'desc' }, { id: 'desc' }],
      ...toSkipTake(query),
    }),
    db.cellReport.count({ where }),
  ]);
  return paged(
    rows.map((r) => present(r, false)),
    total,
    query,
  );
}

// ───────────── Semáforo de cumplimiento ─────────────

export type ComplianceStatus = 'reported' | 'not_held' | 'pending' | 'missing' | 'upcoming';

/**
 * Estado de los reportes de una semana para cada célula activa del alcance:
 * reported/not_held (verde), pending (amarillo: la reunión fue hace ≤ REPORT_GRACE_DAYS días),
 * missing (rojo) y upcoming (todavía no se reunió).
 */
export async function compliance(
  viewer: Viewer,
  query: { week?: string; zoneId?: number; networkId?: number },
) {
  const scope = cellWhereFor(viewer, 'celulas.ver_reportes');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');
  const clock = await accountClock();
  const start = weekStart(query.week ?? clock.today, clock.weekStartsOn);
  const end = addDays(start, 6);
  const db = tenantDb();
  const cells = await db.cell.findMany({
    where: {
      AND: [
        scope,
        { status: 'active' },
        { OR: [{ startedAt: null }, { startedAt: { lte: toDate(end) } }] },
        ...(query.zoneId ? [{ zoneId: query.zoneId }] : []),
        ...(query.networkId ? [{ zone: { networkId: query.networkId } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      meetingDay: true,
      meetingTime: true,
      leader: { select: { id: true, firstName: true, lastName: true, phone: true } },
      zone: { select: { id: true, name: true, network: { select: { id: true, name: true, color: true } } } },
    },
    orderBy: [{ zone: { network: { name: 'asc' } } }, { zone: { name: 'asc' } }, { name: 'asc' }],
  });
  const reports = await db.cellReport.findMany({
    where: { cellId: { in: cells.map((c) => c.id) }, meetingDate: { gte: toDate(start), lte: toDate(end) } },
    select: reportSelect,
  });
  const byCell = new Map(reports.map((r) => [r.cellId, r]));

  const items = cells.map((c) => {
    const expected = meetingDateInWeek(start, clock.weekStartsOn, c.meetingDay);
    const report = byCell.get(c.id);
    let status: ComplianceStatus;
    if (report) status = report.held ? 'reported' : 'not_held';
    else if (expected > clock.today) status = 'upcoming';
    else status = daysBetween(expected, clock.today) <= REPORT_GRACE_DAYS ? 'pending' : 'missing';
    const late = report !== undefined && daysBetween(expected, toIso(report.submittedAt)) > REPORT_GRACE_DAYS;
    return {
      cell: { id: c.id, name: c.name, meetingDay: c.meetingDay, meetingTime: c.meetingTime },
      zone: c.zone,
      leader: c.leader,
      expectedDate: expected,
      status,
      late,
      report: report
        ? { id: report.id, meetingDate: isoDate(report.meetingDate), totals: present(report, false).totals }
        : null,
    };
  });

  const count = (s: ComplianceStatus) => items.filter((i) => i.status === s).length;
  const due = items.filter((i) => i.status !== 'upcoming').length;
  const done = count('reported') + count('not_held');
  return {
    week: { start, end },
    summary: {
      cells: items.length,
      reported: count('reported'),
      notHeld: count('not_held'),
      pending: count('pending'),
      missing: count('missing'),
      upcoming: count('upcoming'),
      rate: due ? Math.round((done / due) * 100) : null,
      attendance: items.reduce((sum, i) => sum + (i.report?.totals.total ?? 0), 0),
      visitors: items.reduce((sum, i) => sum + (i.report?.totals.visitors ?? 0), 0),
    },
    items,
  };
}

// ───────────── Multiplicación y genealogía ─────────────

export async function multiplyCell(viewer: Viewer, motherId: number, input: z.infer<typeof MultiplySchema>) {
  if (!(await inScope(viewer, 'celulas.ver', motherId))) throw AppError.notFound('CELL_NOT_FOUND');
  if (!(await inScope(viewer, 'celulas.multiplicar', motherId)))
    throw AppError.forbidden('MULTIPLY_FORBIDDEN');
  const db = tenantDb();
  const mother = await db.cell.findUniqueOrThrow({ where: { id: motherId } });
  if (mother.status !== 'active') throw AppError.conflict('CELL_CLOSED');
  const zoneId = input.zoneId ?? mother.zoneId;
  if (zoneId !== mother.zoneId) {
    const own = scopeOf(viewer, 'celulas.multiplicar') === 'own';
    const zone = await db.zone.findFirst({
      where: { AND: [{ id: zoneId }, own ? ownZoneWhere(viewer) : {}] },
    });
    if (!zone) throw AppError.badRequest('ZONE_INVALID');
  }

  const clock = await accountClock();
  const date = input.date ?? clock.today;
  if (date > clock.today) throw AppError.badRequest('DATE_IN_FUTURE');
  const motherMembers = new Set(
    (
      await db.cellMember.findMany({ where: { cellId: motherId, leftAt: null }, select: { personId: true } })
    ).map((m) => m.personId),
  );
  const leaders = [input.leaderPersonId, input.coLeaderPersonId, input.hostPersonId].filter(
    (v): v is number => typeof v === 'number',
  );
  const moving = [...new Set([...input.memberIds, ...leaders])];
  // Los que pasan tienen que ser de la célula madre; el líder nuevo también puede venir de afuera.
  if (input.memberIds.some((id) => !motherMembers.has(id))) throw AppError.badRequest('ATTENDANCE_INVALID');
  for (const id of leaders) {
    if (!motherMembers.has(id) && !(await db.person.count({ where: { id, deletedAt: null } }))) {
      throw AppError.badRequest('PERSON_INVALID');
    }
  }
  if (moving.includes(mother.leaderPersonId)) throw AppError.conflict('CELL_LEADER_REQUIRED');

  const accountId = currentAccountId();
  const dateValue = toDate(date);
  const child = await db.$transaction(async (tx) => {
    const created = await tx.cell.create({
      data: {
        accountId,
        zoneId,
        campusId: mother.campusId,
        parentCellId: motherId,
        name: input.name,
        meetingDay: input.meetingDay,
        meetingTime: input.meetingTime,
        address: input.address,
        city: input.city ?? null,
        neighborhood: input.neighborhood ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        leaderPersonId: input.leaderPersonId,
        coLeaderPersonId: input.coLeaderPersonId ?? null,
        hostPersonId: input.hostPersonId ?? null,
        startedAt: dateValue,
      },
      select: { id: true },
    });
    // Quien pasa deja su célula activa actual (la madre u otra) y entra en la nueva.
    await tx.cellMember.updateMany({
      where: { personId: { in: moving }, leftAt: null },
      data: { leftAt: dateValue },
    });
    await tx.cellMember.createMany({
      data: moving.map((personId) => ({ accountId, cellId: created.id, personId, joinedAt: dateValue })),
    });
    await tx.cellMultiplication.create({
      data: {
        accountId,
        motherCellId: motherId,
        childCellId: created.id,
        date: dateValue,
        notes: input.notes ?? null,
        createdById: viewer.userId,
      },
    });
    return created;
  });
  await audit({
    action: 'cells.multiply',
    entity: 'Cell',
    entityId: motherId,
    after: { childCellId: child.id, moved: moving.length, date },
  });
  // La hija tiene otro líder: puede quedar fuera del alcance de quien multiplicó.
  return {
    id: child.id,
    name: input.name,
    parentCellId: motherId,
    visible: await inScope(viewer, 'celulas.ver', child.id),
  };
}

/** Árbol de células (madres → hijas) dentro del alcance; el front arma la jerarquía con parentCellId. */
export async function genealogy(viewer: Viewer) {
  const scope = cellWhereFor(viewer, 'celulas.ver');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');
  const db = tenantDb();
  const cells = await db.cell.findMany({
    where: scope,
    select: {
      id: true,
      name: true,
      status: true,
      parentCellId: true,
      startedAt: true,
      closedAt: true,
      leader: { select: { id: true, firstName: true, lastName: true } },
      zone: { select: { id: true, name: true, network: { select: { id: true, name: true, color: true } } } },
      multipliedFrom: { select: { date: true }, take: 1 },
      _count: { select: { members: { where: { leftAt: null } }, children: true } },
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  const ids = new Set(cells.map((c) => c.id));
  return {
    items: cells.map(({ _count, multipliedFrom, startedAt, closedAt, parentCellId, ...c }) => ({
      ...c,
      // Si la madre no está en el alcance, la célula se muestra como raíz.
      parentCellId: parentCellId && ids.has(parentCellId) ? parentCellId : null,
      startedAt: isoDate(startedAt),
      closedAt: isoDate(closedAt),
      multipliedAt: isoDate(multipliedFrom[0]?.date),
      memberCount: _count.members,
      childCount: _count.children,
    })),
  };
}

/** Datos extra de la ficha de célula: meta de multiplicación y último reporte. */
export async function cellExtras(viewer: Viewer, cellId: number) {
  const clock = await accountClock();
  const [memberCount, last] = await Promise.all([
    tenantDb().cellMember.count({ where: { cellId, leftAt: null } }),
    (await idsInScope(viewer, 'celulas.ver_reportes', [cellId])).has(cellId) ||
    (await idsInScope(viewer, 'celulas.reportar', [cellId])).has(cellId)
      ? tenantDb().cellReport.findFirst({
          where: { cellId },
          orderBy: { meetingDate: 'desc' },
          select: { id: true, meetingDate: true, held: true },
        })
      : Promise.resolve(null),
  ]);
  return {
    multiplication: {
      target: clock.cellMultiplyTarget,
      members: memberCount,
      progress: Math.min(100, Math.round((memberCount / clock.cellMultiplyTarget) * 100)),
      ready: memberCount >= clock.cellMultiplyTarget,
    },
    lastReport: last ? { ...last, meetingDate: isoDate(last.meetingDate) } : null,
    reportEditDays: clock.cellReportEditDays,
    today: clock.today,
  };
}
