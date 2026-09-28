import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { dateToLocal, localToDate, nowLocalIn } from '../../core/time/local-date.js';
import type { Viewer } from '../people/people.scope.js';
import { eventOccurrences } from './calendar.service.js';
import { alignOccurrence, isOccurrence } from './recurrence.js';

// Asistencia a los cultos (y a cualquier fecha de un evento): conteo de adultos, niños, nuevos y
// conexiones online. Una fila por fecha, identificada por el inicio original dentro de la serie.

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const count = z.number().int().min(0).max(100_000);

export const AttendanceSchema = z
  .object({
    adults: count,
    children: count.default(0),
    newcomers: count.default(0),
    online: count.default(0),
    notes: z
      .string()
      .trim()
      .max(500)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .strict();

export const OccurrenceParams = z.object({
  id: z.coerce.number().int().positive(),
  occurrence: localDateTime,
});

export const AttendanceQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  campusId: z.coerce.number().int().positive().optional(),
});

const MAX_RANGE_DAYS = 400;
/** Margen para encontrar las fechas movidas de horario (igual que en el calendario). */
const SHIFT_MS = 31 * 86_400_000;

async function accountNow() {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  return localToDate(nowLocalIn(timezone));
}

const attendanceSelect = {
  adults: true,
  children: true,
  newcomers: true,
  online: true,
  notes: true,
  updatedAt: true,
} as const;

type Counts = {
  adults: number;
  children: number;
  newcomers: number;
  online: number;
  notes: string | null;
  updatedAt: Date;
};
type Attendance = Counts & { inPerson: number };

const withTotal = (r: Counts): Attendance => ({
  adults: r.adults,
  children: r.children,
  newcomers: r.newcomers,
  online: r.online,
  notes: r.notes,
  updatedAt: r.updatedAt,
  inPerson: r.adults + r.children,
});

/** La fecha es de la serie; devuelve su inicio y fin reales (con el cambio de horario aplicado). */
async function occurrenceOf(eventId: number, occurrence: string) {
  const event = await tenantDb().calendarEvent.findFirst({
    where: { id: eventId, deletedAt: null },
    select: {
      id: true,
      title: true,
      type: true,
      location: true,
      startsAt: true,
      endsAt: true,
      rrule: true,
      campus: { select: { id: true, name: true } },
    },
  });
  if (!event) throw AppError.notFound('EVENT_NOT_FOUND');
  const at = localToDate(occurrence);
  const valid = event.rrule
    ? isOccurrence(event.rrule, event.startsAt, at)
    : at.getTime() === event.startsAt.getTime();
  if (!valid) throw AppError.badRequest('OCCURRENCE_INVALID');
  const exception = await tenantDb().eventException.findFirst({
    where: { eventId, originalStart: at },
  });
  const start = exception?.newStartsAt ?? at;
  const end =
    exception?.newEndsAt ?? new Date(start.getTime() + (event.endsAt.getTime() - event.startsAt.getTime()));
  return { event, at, start, end, cancelled: Boolean(exception?.cancelled) };
}

/** Una fecha con su asistencia cargada (o null), para la carga rápida. */
export async function getAttendance(eventId: number, occurrence: string) {
  const o = await occurrenceOf(eventId, occurrence);
  const row = await tenantDb().serviceAttendance.findFirst({
    where: { eventId, occurrenceStart: o.at },
    select: attendanceSelect,
  });
  return {
    event: { id: o.event.id, title: o.event.title, type: o.event.type, location: o.event.location },
    occurrence: dateToLocal(o.at),
    startsAt: dateToLocal(o.start),
    endsAt: dateToLocal(o.end),
    cancelled: o.cancelled,
    started: o.start <= (await accountNow()),
    attendance: row ? withTotal(row) : null,
  };
}

/** Carga o corrige la asistencia de una fecha que ya empezó y no fue cancelada. */
export async function saveAttendance(
  viewer: Viewer,
  eventId: number,
  occurrence: string,
  input: z.infer<typeof AttendanceSchema>,
) {
  const o = await occurrenceOf(eventId, occurrence);
  if (o.cancelled) throw AppError.conflict('OCCURRENCE_CANCELLED');
  if (o.start > (await accountNow())) throw AppError.conflict('ATTENDANCE_FUTURE');
  if (input.newcomers > input.adults + input.children) {
    throw AppError.badRequest('ATTENDANCE_NEWCOMERS_EXCEED');
  }
  const data = {
    adults: input.adults,
    children: input.children,
    newcomers: input.newcomers,
    online: input.online,
    notes: input.notes ?? null,
    recordedById: viewer.userId,
  };
  const db = tenantDb();
  const existing = await db.serviceAttendance.findFirst({
    where: { eventId, occurrenceStart: o.at },
    select: { id: true, ...attendanceSelect },
  });
  if (existing) await db.serviceAttendance.update({ where: { id: existing.id }, data });
  else
    await db.serviceAttendance.create({
      data: { accountId: currentAccountId(), eventId, occurrenceStart: o.at, ...data },
    });
  await audit({
    action: existing ? 'attendance.update' : 'attendance.create',
    entity: 'CalendarEvent',
    entityId: eventId,
    before: existing
      ? {
          adults: existing.adults,
          children: existing.children,
          newcomers: existing.newcomers,
          online: existing.online,
        }
      : undefined,
    after: {
      occurrence,
      adults: data.adults,
      children: data.children,
      newcomers: data.newcomers,
      online: data.online,
    },
  });
  return getAttendance(eventId, occurrence);
}

export async function deleteAttendance(eventId: number, occurrence: string) {
  const o = await occurrenceOf(eventId, occurrence);
  const { count: deleted } = await tenantDb().serviceAttendance.deleteMany({
    where: { eventId, occurrenceStart: o.at },
  });
  if (!deleted) throw AppError.notFound('ATTENDANCE_NOT_FOUND');
  await audit({
    action: 'attendance.delete',
    entity: 'CalendarEvent',
    entityId: eventId,
    before: { occurrence },
  });
}

export interface AttendanceItem {
  key: string;
  eventId: number;
  title: string;
  type: string;
  startsAt: string;
  originalStart: string;
  cancelled: boolean;
  /** Sin asistencia cargada, un culto que ya pasó. */
  pending: boolean;
  attendance: Attendance | null;
}

/**
 * Asistencia del período: las fechas de los cultos que ya empezaron (cargadas o pendientes) y
 * cualquier otra fecha con asistencia cargada, más un resumen de los promedios.
 */
export async function listAttendance(q: z.infer<typeof AttendanceQuery>) {
  if (q.to < q.from) throw AppError.badRequest('DATE_RANGE_INVALID');
  const from = localToDate(`${q.from}T00:00`);
  const to = localToDate(`${q.to}T23:59`);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw AppError.badRequest('ATTENDANCE_RANGE_TOO_LONG', { days: MAX_RANGE_DAYS });
  }
  const now = await accountNow();
  const campus = q.campusId ? { campusId: q.campusId } : {};
  const rows = await tenantDb().serviceAttendance.findMany({
    where: {
      occurrenceStart: { gte: new Date(from.getTime() - SHIFT_MS), lte: new Date(to.getTime() + SHIFT_MS) },
      event: campus,
    },
    select: {
      eventId: true,
      occurrenceStart: true,
      ...attendanceSelect,
      event: { select: { title: true, type: true } },
    },
  });
  const byKey = new Map(rows.map((r) => [`${r.eventId}-${dateToLocal(r.occurrenceStart)}`, r]));
  const occurrences = await eventOccurrences(
    { ...campus, OR: [{ type: 'service' }, { id: { in: [...new Set(rows.map((r) => r.eventId))] } }] },
    from,
    to,
  );
  const items: AttendanceItem[] = [];
  for (const o of occurrences) {
    if (localToDate(o.startsAt) > now) continue;
    const key = `${o.eventId}-${o.originalStart}`;
    const row = byKey.get(key);
    byKey.delete(key);
    if (!row && o.type !== 'service') continue;
    items.push({
      key,
      eventId: o.eventId!,
      title: o.title,
      type: o.type,
      startsAt: o.startsAt,
      originalStart: o.originalStart,
      cancelled: o.cancelled,
      pending: !row && !o.cancelled,
      attendance: row ? withTotal(row) : null,
    });
  }
  // Las cargadas que ya no coinciden con una fecha (evento borrado o serie cambiada) también cuentan.
  for (const [key, r] of byKey) {
    const at = dateToLocal(r.occurrenceStart);
    if (at < `${q.from}T00:00` || at > `${q.to}T23:59`) continue;
    items.push({
      key,
      eventId: r.eventId,
      title: r.event.title,
      type: r.event.type,
      startsAt: at,
      originalStart: at,
      cancelled: false,
      pending: false,
      attendance: withTotal(r),
    });
  }
  items.sort((a, b) => b.startsAt.localeCompare(a.startsAt) || a.title.localeCompare(b.title));
  return { from: q.from, to: q.to, items, summary: summarize(items) };
}

function summarize(items: AttendanceItem[]) {
  const recorded = items.filter((i) => i.attendance);
  const n = recorded.length;
  const sum = (f: (a: Attendance) => number) => recorded.reduce((acc, i) => acc + f(i.attendance!), 0);
  const avg = (f: (a: Attendance) => number) => (n ? Math.round((sum(f) / n) * 10) / 10 : null);
  const peak = recorded.reduce<AttendanceItem | null>(
    (best, i) => (!best || i.attendance!.inPerson > best.attendance!.inPerson ? i : best),
    null,
  );
  return {
    recorded: n,
    pending: items.filter((i) => i.pending).length,
    avgInPerson: avg((a) => a.inPerson),
    avgAdults: avg((a) => a.adults),
    avgChildren: avg((a) => a.children),
    avgOnline: avg((a) => a.online),
    newcomers: sum((a) => a.newcomers),
    peak: peak ? { title: peak.title, startsAt: peak.startsAt, inPerson: peak.attendance!.inPerson } : null,
  };
}

/**
 * Si cambió el horario o la regla del evento, la asistencia pasa a la fecha del mismo día con el
 * horario nuevo. La que ya no tiene fecha ese día queda como estaba (sigue contando en el resumen).
 */
export async function realignAttendance(eventId: number, rule: string | null, start: Date) {
  const db = tenantDb();
  const rows = await db.serviceAttendance.findMany({
    where: { eventId },
    select: { id: true, occurrenceStart: true },
  });
  const taken = new Set(rows.map((r) => r.occurrenceStart.getTime()));
  for (const r of rows) {
    const aligned = alignOccurrence(rule, start, r.occurrenceStart);
    if (aligned && !taken.has(aligned.getTime())) {
      taken.delete(r.occurrenceStart.getTime());
      taken.add(aligned.getTime());
      await db.serviceAttendance.update({ where: { id: r.id }, data: { occurrenceStart: aligned } });
    }
  }
}
