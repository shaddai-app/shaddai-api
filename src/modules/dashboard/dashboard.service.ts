import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import {
  addDays,
  localToDate,
  nowLocalIn,
  startOfDayIn,
  toDate,
  todayIn,
} from '../../core/time/local-date.js';
import { listAttendance } from '../calendar/attendance.service.js';
import { eventOccurrences } from '../calendar/calendar.service.js';
import { cellWhereFor } from '../cells/cells.service.js';
import { caseWhereFor } from '../consolidation/consolidation.service.js';
import { totalsByCurrency } from '../finance/finance.service.js';
import { peopleWhereFor, scopeOf, type Viewer } from '../people/people.scope.js';

// Tablero de inicio: cada bloque aparece solo si el usuario tiene el permiso del módulo y se
// calcula dentro de su alcance (un supervisor ve sus células, no las de toda la iglesia).
// Las cifras del período se comparan con el período anterior de la misma duración.

export const PERIODS = { '7d': 7, '30d': 30, '90d': 90 } as const;
export const DashboardQuery = z.object({
  period: z.enum(Object.keys(PERIODS) as [keyof typeof PERIODS, ...(keyof typeof PERIODS)[]]).default('30d'),
});

const UPCOMING_DAYS = 14;
const UPCOMING_MAX = 6;

interface Range {
  from: string;
  to: string;
  /** Zona horaria de la iglesia: los días son del calendario local. */
  timeZone: string;
}
/** Compara el valor del período con el del anterior. */
const pair = <T>(current: T, previous: T) => ({ current, previous });

/** Rango de fechas (YYYY-MM-DD, incluidas) como instantes, para columnas DateTime (createdAt). */
const instants = (r: Range) => ({
  gte: startOfDayIn(r.from, r.timeZone),
  lt: startOfDayIn(addDays(r.to, 1), r.timeZone),
});
/** Para columnas Date (fechas de negocio). */
const days = (r: Range) => ({ gte: toDate(r.from), lte: toDate(r.to) });

async function people(viewer: Viewer, current: Range, previous: Range) {
  const scope = peopleWhereFor(viewer, 'personas.ver');
  if (!scope) return null;
  const db = tenantDb();
  const base: Prisma.PersonWhereInput = { AND: [scope, { deletedAt: null, mergedIntoId: null }] };
  const created = (r: Range) => db.person.count({ where: { AND: [base, { createdAt: instants(r) }] } });
  const [total, members, visitors, cur, prev] = await Promise.all([
    db.person.count({ where: base }),
    db.person.count({ where: { AND: [base, { status: { systemKey: 'member' } }] } }),
    db.person.count({ where: { AND: [base, { status: { systemKey: { in: ['visitor', 'new'] } } }] } }),
    created(current),
    created(previous),
  ]);
  return { total, members, visitors, added: pair(cur, prev) };
}

async function newcomers(viewer: Viewer) {
  if (!scopeOf(viewer, 'personas.nuevos_revisar')) return null;
  return { pending: await tenantDb().newcomerSubmission.count({ where: { status: 'pending' } }) };
}

async function consolidation(viewer: Viewer, today: string, current: Range, previous: Range) {
  const scope = caseWhereFor(viewer, 'consolidacion.ver');
  if (!scope) return null;
  const db = tenantDb();
  const open: Prisma.ConsolidationCaseWhereInput = { AND: [scope, { status: 'open' }] };
  const completed = (r: Range) =>
    db.consolidationCase.count({ where: { AND: [scope, { status: 'completed', closedAt: days(r) }] } });
  const [openCount, overdue, unassigned, cur, prev] = await Promise.all([
    db.consolidationCase.count({ where: open }),
    db.consolidationCase.count({
      where: { AND: [open, { steps: { some: { completedAt: null, dueAt: { lt: toDate(today) } } } }] },
    }),
    db.consolidationCase.count({ where: { AND: [open, { consolidatorUserId: null }] } }),
    completed(current),
    completed(previous),
  ]);
  return { open: openCount, overdue, unassigned, completed: pair(cur, prev) };
}

async function cells(viewer: Viewer, current: Range, previous: Range) {
  const scope = cellWhereFor(viewer, 'celulas.ver');
  if (!scope) return null;
  const db = tenantDb();
  const active = await db.cell.count({ where: { AND: [scope, { status: 'active' }] } });
  // Los números de las reuniones salen de los reportes (necesitan ver reportes).
  const reportScope = cellWhereFor(viewer, 'celulas.ver_reportes');
  if (!reportScope) return { active, meetings: null };
  const stats = async (r: Range) => {
    const reports = await db.cellReport.findMany({
      where: { held: true, meetingDate: days(r), cell: reportScope },
      select: {
        anonymousVisitors: true,
        childrenCount: true,
        _count: { select: { attendance: true } },
        attendance: { where: { isVisitor: true }, select: { personId: true } },
      },
    });
    const total = reports.reduce(
      (s, x) => s + x._count.attendance + x.anonymousVisitors + x.childrenCount,
      0,
    );
    const visitors = reports.reduce((s, x) => s + x.attendance.length + x.anonymousVisitors, 0);
    return {
      held: reports.length,
      avgAttendance: reports.length ? Math.round((total / reports.length) * 10) / 10 : null,
      visitors,
    };
  };
  const [cur, prev] = await Promise.all([stats(current), stats(previous)]);
  return {
    active,
    meetings: {
      held: pair(cur.held, prev.held),
      avgAttendance: pair(cur.avgAttendance, prev.avgAttendance),
      visitors: pair(cur.visitors, prev.visitors),
    },
  };
}

async function attendance(viewer: Viewer, current: Range, previous: Range) {
  if (!scopeOf(viewer, 'asistencia.ver') && !scopeOf(viewer, 'asistencia.registrar')) return null;
  const [cur, prev] = await Promise.all([listAttendance(current), listAttendance(previous)]);
  return {
    avgInPerson: pair(cur.summary.avgInPerson, prev.summary.avgInPerson),
    avgOnline: pair(cur.summary.avgOnline, prev.summary.avgOnline),
    newcomers: pair(cur.summary.newcomers, prev.summary.newcomers),
    pending: cur.summary.pending,
  };
}

async function finance(viewer: Viewer, current: Range, previous: Range) {
  if (!scopeOf(viewer, 'finanzas.ver')) return null;
  const db = tenantDb();
  const [cur, prev, pending] = await Promise.all([
    totalsByCurrency({ status: 'confirmed', date: days(current) }),
    totalsByCurrency({ status: 'confirmed', date: days(previous) }),
    db.financeMovement.count({ where: { status: 'pending' } }),
  ]);
  const currencies = [...new Set([...cur, ...prev].map((t) => t.currency))].sort();
  const zero = { income: 0, expense: 0, net: 0 };
  return {
    totals: currencies.map((currency) => {
      const c = cur.find((t) => t.currency === currency) ?? zero;
      const p = prev.find((t) => t.currency === currency) ?? zero;
      return {
        currency,
        income: pair(c.income ?? 0, p.income ?? 0),
        expense: pair(c.expense ?? 0, p.expense ?? 0),
        net: pair(c.net ?? 0, p.net ?? 0),
      };
    }),
    pendingOfferings: pending,
  };
}

async function upcoming(viewer: Viewer, timezone: string) {
  if (!scopeOf(viewer, 'eventos.ver')) return null;
  const now = nowLocalIn(timezone);
  const from = localToDate(now);
  const to = localToDate(`${addDays(now.slice(0, 10), UPCOMING_DAYS)}T23:59`);
  const items = await eventOccurrences({}, from, to);
  return items
    .filter((o) => !o.cancelled && o.endsAt >= now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, UPCOMING_MAX);
}

export async function dashboard(viewer: Viewer, q: z.infer<typeof DashboardQuery>) {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  const today = todayIn(timezone);
  const n = PERIODS[q.period];
  const current = { from: addDays(today, -(n - 1)), to: today, timeZone: timezone };
  const previous = { from: addDays(today, -(2 * n - 1)), to: addDays(today, -n), timeZone: timezone };
  const [p, nc, co, ce, at, fi, up] = await Promise.all([
    people(viewer, current, previous),
    newcomers(viewer),
    consolidation(viewer, today, current, previous),
    cells(viewer, current, previous),
    attendance(viewer, current, previous),
    finance(viewer, current, previous),
    upcoming(viewer, timezone),
  ]);
  return {
    period: q.period,
    current: { from: current.from, to: current.to },
    previous: { from: previous.from, to: previous.to },
    people: p,
    newcomers: nc,
    consolidation: co,
    cells: ce,
    attendance: at,
    finance: fi,
    upcoming: up,
  };
}
