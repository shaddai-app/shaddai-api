import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { dateToLocal, localToDate, nowLocalIn } from '../../core/time/local-date.js';
import { cellWhereFor } from '../cells/cells.service.js';
import type { Viewer } from '../people/people.scope.js';
import { endBefore, fromRule, isOccurrence, occurrences, Recurrence, toRule } from './recurrence.js';
import { realignAttendance } from './attendance.service.js';
import { promoteWaitlist, realignRegistrations } from './registrations.service.js';

// ───────────── Constantes y esquemas ─────────────

export const EVENT_TYPES = ['service', 'meeting', 'special', 'other'] as const;
/** Duración con la que se muestran las reuniones de célula (no tienen hora de fin). */
const CELL_MEETING_MINUTES = 120;
/** Cuánto se puede mover una fecha de una serie (y el margen al buscar fechas movidas). */
const MAX_SHIFT_DAYS = 31;
const MAX_RANGE_DAYS = 100;
const MAX_EVENT_DAYS = 14;
const DAY = 86_400_000;

/** "YYYY-MM-DDTHH:mm" (hora local de la iglesia). */
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const EventFields = z.object({
  type: z.enum(EVENT_TYPES),
  title: z.string().trim().min(1).max(150),
  description: optionalText(2000),
  location: optionalText(250),
  startsAt: localDateTime,
  endsAt: localDateTime,
  allDay: z.boolean().default(false),
  campusId: z.number().int().positive().nullable().optional(),
  recurrence: Recurrence.nullable().optional(),
  registrationEnabled: z.boolean().optional(),
  capacity: z.number().int().min(1).max(100_000).nullable().optional(),
  waitlistEnabled: z.boolean().optional(),
  price: z.number().min(0).max(999_999_999).nullable().optional(),
  isPublic: z.boolean().optional(),
});

export const CreateEventSchema = EventFields.strict();
export const UpdateEventSchema = EventFields.partial().strict();
export const SplitEventSchema = EventFields.partial().extend({ occurrence: localDateTime }).strict();

export const ExceptionSchema = z
  .object({
    originalStart: localDateTime,
    cancelled: z.boolean().default(false),
    newStartsAt: localDateTime.nullable().optional(),
    newEndsAt: localDateTime.nullable().optional(),
    note: optionalText(200),
  })
  .strict();

export const CalendarQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
});

// ───────────── Helpers ─────────────

async function accountNow() {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  return nowLocalIn(timezone);
}

/** Normaliza inicio y fin: los de todo el día van de 00:00 a 23:59; el fin no puede ser anterior. */
function normalizeRange(input: { startsAt: string; endsAt: string; allDay: boolean }) {
  const startsAt = input.allDay ? `${input.startsAt.slice(0, 10)}T00:00` : input.startsAt;
  const endsAt = input.allDay ? `${input.endsAt.slice(0, 10)}T23:59` : input.endsAt;
  if (endsAt < startsAt) throw AppError.badRequest('EVENT_RANGE_INVALID');
  if (localToDate(endsAt).getTime() - localToDate(startsAt).getTime() > MAX_EVENT_DAYS * DAY) {
    throw AppError.badRequest('EVENT_TOO_LONG', { days: MAX_EVENT_DAYS });
  }
  return { startsAt, endsAt };
}

async function assertCampus(campusId: number | null | undefined) {
  if (campusId && !(await tenantDb().campus.count({ where: { id: campusId } }))) {
    throw AppError.badRequest('CAMPUS_INVALID');
  }
}

type RegistrationInput = {
  registrationEnabled?: boolean;
  capacity?: number | null;
  waitlistEnabled?: boolean;
  price?: number | null;
  isPublic?: boolean;
};

/**
 * Opciones de inscripción: la lista de espera necesita cupo y el enlace público necesita que la
 * inscripción esté abierta. Sin `before` es un alta (valores por defecto).
 */
function registrationData(
  input: RegistrationInput,
  before?: {
    registrationEnabled: boolean;
    capacity: number | null;
    waitlistEnabled: boolean;
    price: unknown;
    isPublic: boolean;
  },
) {
  const enabled = input.registrationEnabled ?? before?.registrationEnabled ?? false;
  const capacity = input.capacity !== undefined ? input.capacity : (before?.capacity ?? null);
  const price = input.price !== undefined ? input.price : before?.price == null ? null : Number(before.price);
  return {
    registrationEnabled: enabled,
    capacity,
    waitlistEnabled: capacity !== null && (input.waitlistEnabled ?? before?.waitlistEnabled ?? false),
    price,
    isPublic: enabled && (input.isPublic ?? before?.isPublic ?? false),
  };
}
function ruleOf(recurrence: Recurrence | null | undefined, startsAt: string) {
  if (!recurrence) return null;
  if (recurrence.until && recurrence.until < startsAt.slice(0, 10))
    throw AppError.badRequest('RECURRENCE_UNTIL_INVALID');
  return toRule(recurrence, startsAt);
}

const eventSelect = {
  id: true,
  type: true,
  title: true,
  description: true,
  location: true,
  startsAt: true,
  endsAt: true,
  allDay: true,
  rrule: true,
  registrationEnabled: true,
  capacity: true,
  waitlistEnabled: true,
  price: true,
  isPublic: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  campus: { select: { id: true, name: true } },
  exceptions: {
    select: { originalStart: true, cancelled: true, newStartsAt: true, newEndsAt: true, note: true },
    orderBy: { originalStart: 'asc' },
  },
} as const;
type EventRow = Prisma.CalendarEventGetPayload<{ select: typeof eventSelect }>;

export interface Occurrence {
  key: string;
  source: 'event' | 'cell';
  eventId: number | null;
  cellId: number | null;
  type: string;
  title: string;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  recurring: boolean;
  /** Tiene inscripción abierta (los eventos que la habilitan). */
  registration: boolean;
  /** Inicio original de la fecha (identifica la fecha dentro de la serie). */
  originalStart: string;
  cancelled: boolean;
  moved: boolean;
  note: string | null;
}

/** Fechas de un evento que se superponen con [from, to], con las excepciones aplicadas. */
function expand(e: EventRow, from: Date, to: Date): Occurrence[] {
  const duration = e.endsAt.getTime() - e.startsAt.getTime();
  const base = {
    source: 'event' as const,
    eventId: e.id,
    cellId: null,
    type: e.type,
    title: e.title,
    location: e.location,
    allDay: e.allDay,
    recurring: Boolean(e.rrule),
    registration: e.registrationEnabled,
  };
  const overlaps = (s: Date, end: Date) => s <= to && end >= from;
  if (!e.rrule) {
    return overlaps(e.startsAt, e.endsAt)
      ? [
          {
            ...base,
            key: `e${e.id}`,
            startsAt: dateToLocal(e.startsAt),
            endsAt: dateToLocal(e.endsAt),
            originalStart: dateToLocal(e.startsAt),
            cancelled: false,
            moved: false,
            note: null,
          },
        ]
      : [];
  }
  // Ventana ampliada: una fecha puede haberse movido hasta MAX_SHIFT_DAYS.
  const starts = occurrences(
    e.rrule,
    e.startsAt,
    new Date(from.getTime() - duration - MAX_SHIFT_DAYS * DAY),
    new Date(to.getTime() + MAX_SHIFT_DAYS * DAY),
  );
  const exceptions = new Map(e.exceptions.map((x) => [x.originalStart.getTime(), x]));
  const out: Occurrence[] = [];
  for (const original of starts) {
    const x = exceptions.get(original.getTime());
    const start = x?.newStartsAt ?? original;
    const end = x?.newEndsAt ?? new Date(start.getTime() + duration);
    if (!overlaps(start, end)) continue;
    out.push({
      ...base,
      key: `e${e.id}-${dateToLocal(original)}`,
      startsAt: dateToLocal(start),
      endsAt: dateToLocal(end),
      originalStart: dateToLocal(original),
      cancelled: Boolean(x?.cancelled),
      moved: Boolean(x && !x.cancelled && x.newStartsAt),
      note: x?.note ?? null,
    });
  }
  return out;
}

/** Reuniones semanales de las células que el usuario puede ver (sin la dirección exacta). */
async function cellMeetings(viewer: Viewer, from: Date, to: Date): Promise<Occurrence[]> {
  const scope = cellWhereFor(viewer, 'celulas.ver');
  if (!scope) return [];
  const cells = await tenantDb().cell.findMany({
    where: { AND: [scope, { status: 'active' }] },
    select: { id: true, name: true, meetingDay: true, meetingTime: true, startedAt: true },
  });
  const out: Occurrence[] = [];
  for (const c of cells) {
    for (
      let d = new Date(from.getTime() - (from.getTime() % DAY));
      d <= to;
      d = new Date(d.getTime() + DAY)
    ) {
      if (d.getUTCDay() !== c.meetingDay) continue;
      if (c.startedAt && d < c.startedAt) continue;
      const start = localToDate(`${d.toISOString().slice(0, 10)}T${c.meetingTime}`);
      const end = new Date(start.getTime() + CELL_MEETING_MINUTES * 60_000);
      if (start > to || end < from) continue;
      out.push({
        key: `c${c.id}-${dateToLocal(start)}`,
        source: 'cell',
        eventId: null,
        cellId: c.id,
        type: 'cell',
        title: c.name,
        location: null,
        startsAt: dateToLocal(start),
        endsAt: dateToLocal(end),
        allDay: false,
        recurring: true,
        registration: false,
        originalStart: dateToLocal(start),
        cancelled: false,
        moved: false,
        note: null,
      });
    }
  }
  return out;
}

// ───────────── Calendario ─────────────

/** Fechas (con excepciones aplicadas) de los eventos que cumplen `where`, entre from y to. */
export async function eventOccurrences(where: Prisma.CalendarEventWhereInput, from: Date, to: Date) {
  const events = await tenantDb().calendarEvent.findMany({
    where: {
      AND: [
        where,
        {
          deletedAt: null,
          startsAt: { lte: new Date(to.getTime() + MAX_SHIFT_DAYS * DAY) },
          OR: [{ rrule: { not: null } }, { endsAt: { gte: from } }],
        },
      ],
    },
    select: eventSelect,
  });
  return events.flatMap((e) => expand(e, from, to));
}

/** Fechas del período (eventos expandidos + reuniones de célula), ordenadas por inicio. */
export async function calendar(viewer: Viewer, q: z.infer<typeof CalendarQuery>) {
  if (q.to < q.from) throw AppError.badRequest('DATE_RANGE_INVALID');
  const from = localToDate(`${q.from}T00:00`);
  const to = localToDate(`${q.to}T23:59`);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
    throw AppError.badRequest('CALENDAR_RANGE_TOO_LONG', { days: MAX_RANGE_DAYS });
  }
  const types = q.types;
  const eventTypes = (types ?? [...EVENT_TYPES]).filter((t) =>
    (EVENT_TYPES as readonly string[]).includes(t),
  );
  const items = [
    ...(eventTypes.length ? await eventOccurrences({ type: { in: eventTypes } }, from, to) : []),
    ...(!types || types.includes('cell') ? await cellMeetings(viewer, from, to) : []),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.title.localeCompare(b.title));
  return { from: q.from, to: q.to, items };
}

// ───────────── Eventos ─────────────

async function findEvent(id: number) {
  const event = await tenantDb().calendarEvent.findFirst({
    where: { id, deletedAt: null },
    select: eventSelect,
  });
  if (!event) throw AppError.notFound('EVENT_NOT_FOUND');
  return event;
}

export async function getEvent(id: number) {
  const e = await findEvent(id);
  const now = localToDate(await accountNow());
  // Próximas fechas (con excepciones aplicadas), para la ficha.
  const upcoming = expand(e, now, new Date(now.getTime() + 400 * DAY)).slice(0, 6);
  const creator = await tenantDb().user.findUnique({
    where: { id: e.createdById },
    select: { id: true, firstName: true, lastName: true },
  });
  const { rrule, exceptions, startsAt, endsAt, price, ...rest } = e;
  return {
    ...rest,
    price: price === null ? null : Number(price),
    startsAt: dateToLocal(startsAt),
    endsAt: dateToLocal(endsAt),
    recurrence: rrule ? fromRule(rrule) : null,
    exceptions: exceptions.map((x) => ({
      originalStart: dateToLocal(x.originalStart),
      cancelled: x.cancelled,
      newStartsAt: x.newStartsAt ? dateToLocal(x.newStartsAt) : null,
      newEndsAt: x.newEndsAt ? dateToLocal(x.newEndsAt) : null,
      note: x.note,
    })),
    upcoming,
    createdBy: creator,
  };
}

export async function createEvent(viewer: Viewer, input: z.infer<typeof CreateEventSchema>) {
  await assertCampus(input.campusId);
  const range = normalizeRange(input);
  const rrule = ruleOf(input.recurrence, range.startsAt);
  const created = await tenantDb().calendarEvent.create({
    data: {
      accountId: currentAccountId(),
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: localToDate(range.startsAt),
      endsAt: localToDate(range.endsAt),
      allDay: input.allDay,
      rrule,
      campusId: input.campusId ?? null,
      ...registrationData(input),
      createdById: viewer.userId,
    },
    select: { id: true },
  });
  await audit({
    action: 'calendar.event.create',
    entity: 'CalendarEvent',
    entityId: created.id,
    after: { title: input.title, type: input.type, startsAt: range.startsAt, rrule },
  });
  return getEvent(created.id);
}

/**
 * Edita la serie entera. Si cambian el horario o la regla, se descartan las excepciones que ya no
 * corresponden a una fecha de la serie (se informa cuántas).
 */
export async function updateEvent(id: number, input: z.infer<typeof UpdateEventSchema>) {
  const before = await findEvent(id);
  await assertCampus(input.campusId);
  const allDay = input.allDay ?? before.allDay;
  const range = normalizeRange({
    startsAt: input.startsAt ?? dateToLocal(before.startsAt),
    endsAt: input.endsAt ?? dateToLocal(before.endsAt),
    allDay,
  });
  const rrule =
    input.recurrence === undefined
      ? before.rrule && (input.startsAt ? toRule(fromRule(before.rrule), range.startsAt) : before.rrule)
      : ruleOf(input.recurrence, range.startsAt);
  const start = localToDate(range.startsAt);
  const stale = before.exceptions
    .filter((x) => !rrule || !isOccurrence(rrule, start, x.originalStart))
    .map((x) => x.originalStart);
  const {
    recurrence: _r,
    startsAt: _s,
    endsAt: _e,
    registrationEnabled: _re,
    capacity: _c,
    waitlistEnabled: _w,
    price: _p,
    isPublic: _ip,
    ...fields
  } = input;
  const registration = registrationData(input, before);
  const db = tenantDb();
  await db.calendarEvent.update({
    where: { id },
    data: {
      ...fields,
      ...registration,
      allDay,
      startsAt: start,
      endsAt: localToDate(range.endsAt),
      rrule,
      ...(stale.length ? { exceptions: { deleteMany: { originalStart: { in: stale } } } } : {}),
    },
  });
  await audit({
    action: 'calendar.event.update',
    entity: 'CalendarEvent',
    entityId: id,
    before: { title: before.title, startsAt: dateToLocal(before.startsAt), rrule: before.rrule },
    after: { changed: Object.keys(input), removedExceptions: stale.length },
  });
  // Las inscripciones y la asistencia siguen a su fecha si cambió el horario, y con más cupo sube
  // la lista de espera.
  await realignRegistrations(id, rrule, start, localToDate(range.endsAt));
  await realignAttendance(id, rrule, start);
  await promoteWaitlist(id);
  return { ...(await getEvent(id)), removedExceptions: stale.length };
}

/**
 * "Esta fecha y las siguientes": la serie original termina antes de `occurrence` y desde ahí sigue
 * un evento nuevo con los cambios. Las excepciones posteriores pasan al nuevo si el horario no
 * cambió (si cambió, ya no corresponden y se descartan).
 */
export async function splitEvent(viewer: Viewer, id: number, input: z.infer<typeof SplitEventSchema>) {
  const before = await findEvent(id);
  if (!before.rrule) throw AppError.conflict('EVENT_NOT_RECURRING');
  const at = localToDate(input.occurrence);
  if (!isOccurrence(before.rrule, before.startsAt, at)) throw AppError.badRequest('OCCURRENCE_INVALID');
  if (at.getTime() === before.startsAt.getTime()) throw AppError.conflict('SPLIT_AT_FIRST');
  const duration = before.endsAt.getTime() - before.startsAt.getTime();
  const allDay = input.allDay ?? before.allDay;
  const range = normalizeRange({
    startsAt: input.startsAt ?? input.occurrence,
    endsAt: input.endsAt ?? dateToLocal(new Date(at.getTime() + duration)),
    allDay,
  });
  const recurrence = input.recurrence === undefined ? fromRule(before.rrule) : input.recurrence;
  const newRule = ruleOf(recurrence, range.startsAt);
  const newStart = localToDate(range.startsAt);
  const later = before.exceptions.filter((x) => x.originalStart >= at);
  const kept = newRule ? later.filter((x) => isOccurrence(newRule, newStart, x.originalStart)) : [];
  await assertCampus(input.campusId);
  const db = tenantDb();
  const createdId = await db.$transaction(async (tx) => {
    await tx.calendarEvent.update({
      where: { id },
      data: {
        rrule: endBefore(before.rrule!, at),
        exceptions: { deleteMany: { originalStart: { gte: at } } },
      },
    });
    const created = await tx.calendarEvent.create({
      data: {
        accountId: currentAccountId(),
        type: input.type ?? before.type,
        title: input.title ?? before.title,
        description: input.description !== undefined ? input.description : before.description,
        location: input.location !== undefined ? input.location : before.location,
        startsAt: newStart,
        endsAt: localToDate(range.endsAt),
        allDay,
        rrule: newRule,
        campusId: input.campusId !== undefined ? input.campusId : (before.campus?.id ?? null),
        ...registrationData(input, before),
        createdById: viewer.userId,
        // Escritura anidada: las excepciones son hijas del evento nuevo.
        exceptions: {
          create: kept.map((x) => ({
            originalStart: x.originalStart,
            cancelled: x.cancelled,
            newStartsAt: x.newStartsAt,
            newEndsAt: x.newEndsAt,
            note: x.note,
          })),
        },
      },
      select: { id: true },
    });
    // Las inscripciones y la asistencia de las fechas que pasan al evento nuevo lo acompañan.
    await tx.eventRegistration.updateMany({
      where: { eventId: id, occurrenceStart: { gte: at } },
      data: { eventId: created.id },
    });
    await tx.serviceAttendance.updateMany({
      where: { eventId: id, occurrenceStart: { gte: at } },
      data: { eventId: created.id },
    });
    return created.id;
  });
  await realignRegistrations(createdId, newRule, newStart, localToDate(range.endsAt));
  await realignAttendance(createdId, newRule, newStart);
  await audit({
    action: 'calendar.event.split',
    entity: 'CalendarEvent',
    entityId: id,
    after: { from: input.occurrence, newEventId: createdId, changed: Object.keys(input) },
  });
  return getEvent(createdId);
}

export async function deleteEvent(id: number) {
  const event = await findEvent(id);
  await tenantDb().calendarEvent.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit({
    action: 'calendar.event.delete',
    entity: 'CalendarEvent',
    entityId: id,
    before: { title: event.title },
  });
}

// ───────────── Excepciones (una sola fecha) ─────────────

export async function setException(id: number, input: z.infer<typeof ExceptionSchema>) {
  const event = await findEvent(id);
  if (!event.rrule) throw AppError.conflict('EVENT_NOT_RECURRING');
  const original = localToDate(input.originalStart);
  if (!isOccurrence(event.rrule, event.startsAt, original)) throw AppError.badRequest('OCCURRENCE_INVALID');
  let newStartsAt: Date | null = null;
  let newEndsAt: Date | null = null;
  if (!input.cancelled) {
    if (!input.newStartsAt) throw AppError.badRequest('EXCEPTION_EMPTY');
    const duration = event.endsAt.getTime() - event.startsAt.getTime();
    const range = normalizeRange({
      startsAt: input.newStartsAt,
      endsAt: input.newEndsAt ?? dateToLocal(new Date(localToDate(input.newStartsAt).getTime() + duration)),
      allDay: event.allDay,
    });
    newStartsAt = localToDate(range.startsAt);
    newEndsAt = localToDate(range.endsAt);
    if (Math.abs(newStartsAt.getTime() - original.getTime()) > MAX_SHIFT_DAYS * DAY) {
      throw AppError.badRequest('EXCEPTION_TOO_FAR', { days: MAX_SHIFT_DAYS });
    }
  }
  const data = { cancelled: input.cancelled, newStartsAt, newEndsAt, note: input.note ?? null };
  const db = tenantDb();
  const existing = await db.eventException.findFirst({ where: { eventId: id, originalStart: original } });
  if (existing) await db.eventException.update({ where: { id: existing.id }, data });
  else await db.eventException.create({ data: { eventId: id, originalStart: original, ...data } });
  await audit({
    action: 'calendar.exception.set',
    entity: 'CalendarEvent',
    entityId: id,
    after: {
      originalStart: input.originalStart,
      cancelled: input.cancelled,
      newStartsAt: input.newStartsAt ?? null,
    },
  });
  return getEvent(id);
}

export async function clearException(id: number, originalStart: string) {
  await findEvent(id);
  const { count } = await tenantDb().eventException.deleteMany({
    where: { eventId: id, originalStart: localToDate(originalStart) },
  });
  if (!count) throw AppError.notFound('EXCEPTION_NOT_FOUND');
  await audit({
    action: 'calendar.exception.clear',
    entity: 'CalendarEvent',
    entityId: id,
    before: { originalStart },
  });
  return getEvent(id);
}
