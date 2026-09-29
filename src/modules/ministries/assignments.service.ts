import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { addDays, dateToLocal, localToDate, toDate } from '../../core/time/local-date.js';
import { EVENT_TYPES, eventOccurrences, occurrenceInfo } from '../calendar/calendar.service.js';
import { alignOccurrence } from '../calendar/recurrence.js';
import { isoDate } from '../people/people.service.js';
import type { Viewer } from '../people/people.scope.js';
import { accountNow, ministryInScope } from './ministries.service.js';

// Turnos: quién sirve en qué puesto de un ministerio en cada fecha de un evento. La persona lo
// acepta o lo rechaza, y puede avisar las fechas en las que no está disponible.

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const DAY = 86_400_000;
/** Margen para encontrar las fechas movidas de horario (igual que en el calendario). */
const SHIFT_MS = 31 * DAY;
const MAX_SCHEDULE_DAYS = 92;
const MAX_UNAVAILABLE_DAYS = 366;

export const ScheduleQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  types: z
    .string()
    .optional()
    .transform((v) =>
      (v ? v.split(',') : ['service', 'special']).filter((t) =>
        (EVENT_TYPES as readonly string[]).includes(t),
      ),
    ),
});

export const AssignSchema = z
  .object({
    eventId: z.number().int().positive(),
    occurrence: localDateTime,
    serviceRoleId: z.number().int().positive(),
    personId: z.number().int().positive(),
    notes: z
      .string()
      .trim()
      .max(300)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .strict();

export const RespondSchema = z
  .object({
    response: z.enum(['accept', 'decline']),
    reason: z
      .string()
      .trim()
      .max(300)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .strict();

export const UnavailabilitySchema = z
  .object({
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
    reason: z
      .string()
      .trim()
      .max(200)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .strict();

const personRef = { id: true, firstName: true, lastName: true, phone: true } as const;

/** Clave de una fecha de un evento (evento + inicio original). */
const keyOf = (eventId: number, occurrence: Date | string) =>
  `${eventId}-${typeof occurrence === 'string' ? occurrence : dateToLocal(occurrence)}`;

async function visible(viewer: Viewer, ministryId: number) {
  if (!(await ministryInScope(viewer, 'ministerios.ver', ministryId))) {
    throw AppError.notFound('MINISTRY_NOT_FOUND');
  }
}

async function assignable(viewer: Viewer, ministryId: number) {
  await visible(viewer, ministryId);
  if (!(await ministryInScope(viewer, 'ministerios.turnos', ministryId))) {
    throw AppError.forbidden('ASSIGNMENTS_FORBIDDEN');
  }
}

// ───────────── Grilla de turnos de un ministerio ─────────────

/**
 * Fechas del período con los turnos del ministerio, sus puestos e integrantes, y lo necesario para
 * advertir al asignar: no disponibilidades y turnos de los integrantes en otros ministerios.
 */
export async function schedule(viewer: Viewer, ministryId: number, q: z.infer<typeof ScheduleQuery>) {
  await visible(viewer, ministryId);
  if (q.to < q.from) throw AppError.badRequest('DATE_RANGE_INVALID');
  const from = localToDate(`${q.from}T00:00`);
  const to = localToDate(`${q.to}T23:59`);
  if (to.getTime() - from.getTime() > MAX_SCHEDULE_DAYS * DAY) {
    throw AppError.badRequest('SCHEDULE_RANGE_TOO_LONG', { days: MAX_SCHEDULE_DAYS });
  }
  const db = tenantDb();
  const window = { gte: new Date(from.getTime() - SHIFT_MS), lte: new Date(to.getTime() + SHIFT_MS) };
  const [ministry, occurrences, assignments] = await Promise.all([
    db.ministry.findUniqueOrThrow({
      where: { id: ministryId },
      select: {
        id: true,
        name: true,
        color: true,
        roles: {
          select: { id: true, name: true, isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
        members: {
          where: { leftAt: null },
          select: { role: true, person: { select: personRef } },
        },
      },
    }),
    q.types.length ? eventOccurrences({ type: { in: q.types } }, from, to) : Promise.resolve([]),
    db.serviceAssignment.findMany({
      where: { ministryId, occurrenceStart: window },
      select: {
        id: true,
        eventId: true,
        occurrenceStart: true,
        serviceRoleId: true,
        status: true,
        declineReason: true,
        notes: true,
        person: { select: personRef },
      },
    }),
  ]);
  const personIds = ministry.members.map((m) => m.person.id);
  const [unavailability, elsewhere] = await Promise.all([
    db.unavailability.findMany({
      where: {
        personId: { in: personIds },
        fromDate: { lte: toDate(q.to) },
        toDate: { gte: toDate(q.from) },
      },
      select: { personId: true, fromDate: true, toDate: true, reason: true },
    }),
    db.serviceAssignment.findMany({
      where: { personId: { in: personIds }, ministryId: { not: ministryId }, occurrenceStart: window },
      select: {
        personId: true,
        eventId: true,
        occurrenceStart: true,
        status: true,
        ministry: { select: { name: true } },
        serviceRole: { select: { name: true } },
      },
    }),
  ]);
  const byOccurrence = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const k = keyOf(a.eventId, a.occurrenceStart);
    byOccurrence.set(k, [...(byOccurrence.get(k) ?? []), a]);
  }
  const usedRoles = new Set(assignments.map((a) => a.serviceRoleId));
  return {
    from: q.from,
    to: q.to,
    ministry: { id: ministry.id, name: ministry.name, color: ministry.color },
    canAssign: await ministryInScope(viewer, 'ministerios.turnos', ministryId),
    // Los puestos inactivos solo aparecen si tienen turnos en el período.
    roles: ministry.roles.filter((r) => r.isActive || usedRoles.has(r.id)),
    members: ministry.members.map((m) => ({ ...m.person, role: m.role })),
    occurrences: occurrences
      .filter((o) => o.eventId !== null)
      .map((o) => ({
        eventId: o.eventId!,
        title: o.title,
        type: o.type,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        originalStart: o.originalStart,
        cancelled: o.cancelled,
        assignments: (byOccurrence.get(keyOf(o.eventId!, o.originalStart)) ?? []).map((a) => ({
          id: a.id,
          serviceRoleId: a.serviceRoleId,
          status: a.status,
          declineReason: a.declineReason,
          notes: a.notes,
          person: a.person,
        })),
      })),
    unavailability: unavailability.map((u) => ({
      personId: u.personId,
      fromDate: isoDate(u.fromDate)!,
      toDate: isoDate(u.toDate)!,
      reason: u.reason,
    })),
    elsewhere: elsewhere
      .filter((e) => e.status !== 'declined')
      .map((e) => ({
        personId: e.personId,
        eventId: e.eventId,
        occurrence: dateToLocal(e.occurrenceStart),
        ministry: e.ministry.name,
        role: e.serviceRole.name,
      })),
  };
}

// ───────────── Asignar y quitar ─────────────

/** Advertencias (no bloquean): no disponible ese día, u otro turno en la misma fecha. */
async function warningsFor(personId: number, eventId: number, at: Date, start: Date, exceptId?: number) {
  const db = tenantDb();
  const day = toDate(dateToLocal(start).slice(0, 10));
  const [unavailable, others] = await Promise.all([
    db.unavailability.findFirst({
      where: { personId, fromDate: { lte: day }, toDate: { gte: day } },
      select: { reason: true },
    }),
    db.serviceAssignment.findMany({
      where: {
        personId,
        eventId,
        occurrenceStart: at,
        status: { not: 'declined' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { ministry: { select: { name: true } }, serviceRole: { select: { name: true } } },
    }),
  ]);
  return [
    ...(unavailable ? [{ code: 'UNAVAILABLE', reason: unavailable.reason }] : []),
    ...others.map((o) => ({ code: 'ALREADY_ASSIGNED', ministry: o.ministry.name, role: o.serviceRole.name })),
  ];
}

export async function assign(viewer: Viewer, ministryId: number, input: z.infer<typeof AssignSchema>) {
  await assignable(viewer, ministryId);
  const db = tenantDb();
  const role = await db.serviceRole.findFirst({ where: { id: input.serviceRoleId, ministryId } });
  if (!role) throw AppError.badRequest('SERVICE_ROLE_NOT_FOUND');
  if (!role.isActive) throw AppError.conflict('SERVICE_ROLE_INACTIVE');
  if (!(await db.ministryMember.count({ where: { ministryId, personId: input.personId, leftAt: null } }))) {
    throw AppError.badRequest('ASSIGNMENT_NOT_MEMBER');
  }
  const o = await occurrenceInfo(input.eventId, input.occurrence);
  if (o.cancelled) throw AppError.conflict('OCCURRENCE_CANCELLED');
  if (o.end <= (await accountNow())) throw AppError.conflict('ASSIGNMENT_PAST');
  const exists = await db.serviceAssignment.count({
    where: {
      eventId: input.eventId,
      occurrenceStart: o.at,
      serviceRoleId: role.id,
      personId: input.personId,
    },
  });
  if (exists) throw AppError.conflict('ASSIGNMENT_EXISTS');
  const warnings = await warningsFor(input.personId, input.eventId, o.at, o.start);
  const created = await db.serviceAssignment.create({
    data: {
      accountId: currentAccountId(),
      eventId: input.eventId,
      occurrenceStart: o.at,
      ministryId,
      serviceRoleId: role.id,
      personId: input.personId,
      notes: input.notes ?? null,
      assignedById: viewer.userId,
    },
    select: { id: true },
  });
  await audit({
    action: 'ministries.assignment.create',
    entity: 'Ministry',
    entityId: ministryId,
    after: { assignmentId: created.id, ...input, warnings: warnings.map((w) => w.code) },
  });
  return { id: created.id, warnings };
}

export async function unassign(viewer: Viewer, ministryId: number, assignmentId: number) {
  await assignable(viewer, ministryId);
  const db = tenantDb();
  const a = await db.serviceAssignment.findFirst({
    where: { id: assignmentId, ministryId },
    select: { id: true, personId: true, eventId: true, occurrenceStart: true },
  });
  if (!a) throw AppError.notFound('ASSIGNMENT_NOT_FOUND');
  await db.serviceAssignment.delete({ where: { id: a.id } });
  await audit({
    action: 'ministries.assignment.delete',
    entity: 'Ministry',
    entityId: ministryId,
    before: { personId: a.personId, eventId: a.eventId, occurrence: dateToLocal(a.occurrenceStart) },
  });
}

// ───────────── Mis turnos ─────────────

/** Los turnos de la persona vinculada al usuario, desde hoy, con quiénes sirven en la misma fecha. */
export async function myAssignments(viewer: Viewer) {
  if (!viewer.personId) return { linked: false, items: [] };
  const db = tenantDb();
  const now = await accountNow();
  const since = localToDate(`${dateToLocal(now).slice(0, 10)}T00:00`);
  const rows = await db.serviceAssignment.findMany({
    where: { personId: viewer.personId, occurrenceStart: { gte: new Date(since.getTime() - SHIFT_MS) } },
    select: {
      id: true,
      eventId: true,
      occurrenceStart: true,
      ministryId: true,
      status: true,
      declineReason: true,
      notes: true,
      respondedAt: true,
      ministry: { select: { id: true, name: true, color: true } },
      serviceRole: { select: { name: true } },
    },
    orderBy: { occurrenceStart: 'asc' },
    take: 100,
  });
  const items = [];
  for (const r of rows) {
    const o = await occurrenceInfo(r.eventId, dateToLocal(r.occurrenceStart)).catch(() => null);
    if (!o || o.end < since) continue; // el evento se borró, o la fecha ya pasó
    const team = await db.serviceAssignment.findMany({
      where: {
        eventId: r.eventId,
        occurrenceStart: r.occurrenceStart,
        ministryId: r.ministryId,
        id: { not: r.id },
      },
      select: { status: true, serviceRole: { select: { name: true } }, person: { select: personRef } },
    });
    items.push({
      id: r.id,
      status: r.status,
      declineReason: r.declineReason,
      notes: r.notes,
      respondedAt: r.respondedAt,
      ministry: r.ministry,
      role: r.serviceRole.name,
      event: o.event,
      occurrence: dateToLocal(o.at),
      startsAt: dateToLocal(o.start),
      endsAt: dateToLocal(o.end),
      cancelled: o.cancelled,
      team: team.map((t) => ({ role: t.serviceRole.name, status: t.status, person: t.person })),
    });
  }
  items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { linked: true, items };
}

export async function respond(viewer: Viewer, id: number, input: z.infer<typeof RespondSchema>) {
  const db = tenantDb();
  const a = viewer.personId
    ? await db.serviceAssignment.findFirst({
        where: { id, personId: viewer.personId },
        select: { id: true, eventId: true, occurrenceStart: true, status: true, ministryId: true },
      })
    : null;
  if (!a) throw AppError.notFound('ASSIGNMENT_NOT_FOUND');
  const o = await occurrenceInfo(a.eventId, dateToLocal(a.occurrenceStart));
  if (o.end <= (await accountNow())) throw AppError.conflict('ASSIGNMENT_PAST');
  const status = input.response === 'accept' ? 'accepted' : 'declined';
  await db.serviceAssignment.update({
    where: { id },
    data: {
      status,
      respondedAt: new Date(),
      declineReason: status === 'declined' ? (input.reason ?? null) : null,
    },
  });
  await audit({
    action: 'ministries.assignment.respond',
    entity: 'Ministry',
    entityId: a.ministryId,
    before: { assignmentId: id, status: a.status },
    after: { status },
  });
  return myAssignments(viewer);
}

// ───────────── No disponibilidad ─────────────

function requirePerson(viewer: Viewer) {
  if (!viewer.personId) throw AppError.conflict('PERSON_NOT_LINKED');
  return viewer.personId;
}

export async function myUnavailability(viewer: Viewer) {
  if (!viewer.personId) return { linked: false, items: [] };
  const today = dateToLocal(await accountNow()).slice(0, 10);
  const rows = await tenantDb().unavailability.findMany({
    where: { personId: viewer.personId, toDate: { gte: toDate(today) } },
    select: { id: true, fromDate: true, toDate: true, reason: true },
    orderBy: { fromDate: 'asc' },
  });
  return {
    linked: true,
    items: rows.map((r) => ({ ...r, fromDate: isoDate(r.fromDate)!, toDate: isoDate(r.toDate)! })),
  };
}

export async function addUnavailability(viewer: Viewer, input: z.infer<typeof UnavailabilitySchema>) {
  const personId = requirePerson(viewer);
  if (input.toDate < input.fromDate) throw AppError.badRequest('DATE_RANGE_INVALID');
  if (input.toDate > addDays(input.fromDate, MAX_UNAVAILABLE_DAYS)) {
    throw AppError.badRequest('UNAVAILABILITY_TOO_LONG', { days: MAX_UNAVAILABLE_DAYS });
  }
  const db = tenantDb();
  const created = await db.unavailability.create({
    data: {
      accountId: currentAccountId(),
      personId,
      fromDate: toDate(input.fromDate),
      toDate: toDate(input.toDate),
      reason: input.reason ?? null,
      createdById: viewer.userId,
    },
    select: { id: true },
  });
  // Turnos ya asignados en esas fechas (para avisarle que los rechace si corresponde).
  const conflicts = await db.serviceAssignment.count({
    where: {
      personId,
      status: { not: 'declined' },
      occurrenceStart: {
        gte: localToDate(`${input.fromDate}T00:00`),
        lte: localToDate(`${input.toDate}T23:59`),
      },
    },
  });
  await audit({ action: 'people.unavailability.create', entity: 'Person', entityId: personId, after: input });
  return { id: created.id, conflicts, ...(await myUnavailability(viewer)) };
}

export async function deleteUnavailability(viewer: Viewer, id: number) {
  const personId = requirePerson(viewer);
  const { count } = await tenantDb().unavailability.deleteMany({ where: { id, personId } });
  if (!count) throw AppError.notFound('UNAVAILABILITY_NOT_FOUND');
  await audit({
    action: 'people.unavailability.delete',
    entity: 'Person',
    entityId: personId,
    before: { id },
  });
  return myUnavailability(viewer);
}

// ───────────── Cambios en el calendario ─────────────

/**
 * Si cambió el horario o la regla del evento, los turnos pasan a la fecha del mismo día con el
 * horario nuevo. Los que ya no tienen fecha ese día quedan como estaban (historial).
 */
export async function realignAssignments(eventId: number, rule: string | null, start: Date) {
  const db = tenantDb();
  const rows = await db.serviceAssignment.findMany({
    where: { eventId },
    select: { id: true, occurrenceStart: true, serviceRoleId: true, personId: true },
  });
  const slot = (at: Date, r: { serviceRoleId: number; personId: number }) =>
    `${at.getTime()}-${r.serviceRoleId}-${r.personId}`;
  const taken = new Set(rows.map((r) => slot(r.occurrenceStart, r)));
  for (const r of rows) {
    const aligned = alignOccurrence(rule, start, r.occurrenceStart);
    if (!aligned || aligned.getTime() === r.occurrenceStart.getTime() || taken.has(slot(aligned, r)))
      continue;
    taken.delete(slot(r.occurrenceStart, r));
    taken.add(slot(aligned, r));
    await db.serviceAssignment.update({ where: { id: r.id }, data: { occurrenceStart: aligned } });
  }
}
