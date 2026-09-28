import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { dateToLocal, localToDate, nowLocalIn } from '../../core/time/local-date.js';
import { createMovement, ensureSystemCategory } from '../finance/finance.service.js';
import { normalizePhone } from '../people/people.service.js';
import { scopeOf, type Viewer } from '../people/people.scope.js';
import { isOccurrence, occurrences } from './recurrence.js';

// Inscripciones a una fecha de un evento. Cupo por fecha; con cupo lleno, lista de espera (si está
// habilitada) que sube por orden de llegada cuando alguien cancela o se amplía el cupo.

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const email = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.email().max(150).nullable())
  .nullable()
  .optional();

export const RegistrationSchema = z
  .object({
    occurrence: localDateTime,
    personId: z.number().int().positive().nullable().optional(),
    name: optionalText(150),
    email,
    phone: optionalText(30),
    notes: optionalText(500),
  })
  .strict()
  .refine((r) => Boolean(r.personId || r.name), { message: 'NAME_REQUIRED', path: ['name'] });

export const OccurrenceQuery = z.object({ occurrence: localDateTime });

const ACTIVE = ['confirmed', 'waitlist'];

type EventForRegistration = {
  id: number;
  title: string;
  startsAt: Date;
  endsAt: Date;
  rrule: string | null;
  registrationEnabled: boolean;
  capacity: number | null;
  waitlistEnabled: boolean;
  isPublic: boolean;
  price: Prisma.Decimal | null;
};

const eventSelect = {
  id: true,
  title: true,
  startsAt: true,
  endsAt: true,
  rrule: true,
  registrationEnabled: true,
  capacity: true,
  waitlistEnabled: true,
  isPublic: true,
  price: true,
} as const;

async function findEvent(id: number): Promise<EventForRegistration> {
  const event = await tenantDb().calendarEvent.findFirst({
    where: { id, deletedAt: null },
    select: eventSelect,
  });
  if (!event) throw AppError.notFound('EVENT_NOT_FOUND');
  return event;
}

async function accountNow() {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  return localToDate(nowLocalIn(timezone));
}

/**
 * La fecha (inicio original) es de la serie y se puede usar: no cancelada y, para anotarse, que no
 * haya terminado. Devuelve su inicio y fin reales (con el cambio de horario aplicado).
 */
async function occurrenceOf(event: EventForRegistration, occurrence: string, forRegistration: boolean) {
  const at = localToDate(occurrence);
  const valid = event.rrule
    ? isOccurrence(event.rrule, event.startsAt, at)
    : at.getTime() === event.startsAt.getTime();
  if (!valid) throw AppError.badRequest('OCCURRENCE_INVALID');
  const exception = await tenantDb().eventException.findFirst({
    where: { eventId: event.id, originalStart: at },
  });
  const start = exception?.newStartsAt ?? at;
  const end =
    exception?.newEndsAt ?? new Date(start.getTime() + (event.endsAt.getTime() - event.startsAt.getTime()));
  if (forRegistration) {
    if (!event.registrationEnabled) throw AppError.conflict('REGISTRATION_DISABLED');
    if (exception?.cancelled) throw AppError.conflict('OCCURRENCE_CANCELLED');
    if (end <= (await accountNow())) throw AppError.conflict('REGISTRATION_CLOSED');
  }
  return { at, start, end, cancelled: Boolean(exception?.cancelled) };
}

async function countsFor(eventId: number, at: Date) {
  const rows = await tenantDb().eventRegistration.groupBy({
    by: ['status'],
    where: { eventId, occurrenceStart: at, status: { in: ACTIVE } },
    _count: true,
  });
  const of = (s: string) => rows.find((r) => r.status === s)?._count ?? 0;
  return { confirmed: of('confirmed'), waitlist: of('waitlist') };
}

const availability = (event: EventForRegistration, counts: { confirmed: number; waitlist: number }) => ({
  capacity: event.capacity,
  confirmed: counts.confirmed,
  waitlist: counts.waitlist,
  available: event.capacity === null ? null : Math.max(event.capacity - counts.confirmed, 0),
  full: event.capacity !== null && counts.confirmed >= event.capacity,
});

const registrationSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  notes: true,
  status: true,
  source: true,
  paidAmount: true,
  paymentMovementId: true,
  createdAt: true,
  cancelledAt: true,
  occurrenceStart: true,
  person: { select: { id: true, firstName: true, lastName: true } },
} as const;
type RegistrationRow = Prisma.EventRegistrationGetPayload<{ select: typeof registrationSelect }>;

const presentRegistration = ({ paidAmount, occurrenceStart, ...r }: RegistrationRow) => ({
  ...r,
  occurrenceStart: dateToLocal(occurrenceStart),
  paidAmount: paidAmount === null ? null : Number(paidAmount),
});

// ───────────── Listado ─────────────

export async function listRegistrations(eventId: number, occurrence: string) {
  const event = await findEvent(eventId);
  const occ = await occurrenceOf(event, occurrence, false);
  const rows = await tenantDb().eventRegistration.findMany({
    where: { eventId, occurrenceStart: occ.at },
    select: registrationSelect,
    // Confirmados, después la lista de espera por orden de llegada y al final los cancelados.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const order = { confirmed: 0, waitlist: 1, cancelled: 2 } as Record<string, number>;
  return {
    event: {
      id: event.id,
      title: event.title,
      price: event.price === null ? null : Number(event.price),
      waitlistEnabled: event.waitlistEnabled,
      registrationEnabled: event.registrationEnabled,
      isPublic: event.isPublic,
    },
    occurrence: {
      originalStart: occurrence,
      startsAt: dateToLocal(occ.start),
      endsAt: dateToLocal(occ.end),
      cancelled: occ.cancelled,
    },
    ...availability(event, await countsFor(eventId, occ.at)),
    items: rows.sort((a, b) => order[a.status]! - order[b.status]!).map(presentRegistration),
  };
}

// ───────────── Alta ─────────────

/**
 * Anota a alguien en una fecha. Con una persona de la base se toman sus datos; si no, nombre y
 * contacto. No se anota dos veces a la misma persona (ni el mismo email o teléfono) en la misma fecha.
 */
export async function createRegistration(
  viewer: Viewer | null,
  eventId: number,
  input: z.infer<typeof RegistrationSchema>,
  source: 'staff' | 'public' = 'staff',
) {
  const event = await findEvent(eventId);
  if (source === 'public' && !event.isPublic) throw AppError.notFound('EVENT_NOT_FOUND');
  const occ = await occurrenceOf(event, input.occurrence, true);
  const db = tenantDb();
  let name = input.name ?? null;
  let emailValue = input.email ?? null;
  let phone = normalizePhone(input.phone);
  if (input.personId) {
    const person = await db.person.findFirst({
      where: { id: input.personId, deletedAt: null },
      select: { firstName: true, lastName: true, email: true, phone: true },
    });
    if (!person) throw AppError.badRequest('PERSON_INVALID');
    name ??= `${person.firstName} ${person.lastName}`;
    emailValue ??= person.email;
    phone ??= person.phone;
  }
  const same: Prisma.EventRegistrationWhereInput[] = [
    ...(input.personId ? [{ personId: input.personId }] : []),
    ...(emailValue ? [{ email: emailValue }] : []),
    ...(phone ? [{ phone }] : []),
  ];
  if (same.length) {
    const duplicate = await db.eventRegistration.findFirst({
      where: { eventId, occurrenceStart: occ.at, status: { in: ACTIVE }, OR: same },
      select: { id: true, status: true },
    });
    if (duplicate) throw AppError.conflict('REGISTRATION_EXISTS', { status: duplicate.status });
  }
  const counts = await countsFor(eventId, occ.at);
  const full = event.capacity !== null && counts.confirmed >= event.capacity;
  if (full && !event.waitlistEnabled) throw AppError.conflict('EVENT_FULL');
  const created = await db.eventRegistration.create({
    data: {
      accountId: currentAccountId(),
      eventId,
      occurrenceStart: occ.at,
      personId: input.personId ?? null,
      name: name!,
      email: emailValue,
      phone,
      notes: input.notes ?? null,
      status: full ? 'waitlist' : 'confirmed',
      source,
      createdById: viewer?.userId ?? null,
    },
    select: registrationSelect,
  });
  await audit({
    action: 'calendar.registration.create',
    entity: 'EventRegistration',
    entityId: created.id,
    after: { eventId, occurrence: input.occurrence, status: created.status, source },
    ...(viewer ? {} : { userId: null }),
  });
  return presentRegistration(created);
}

// ───────────── Baja y lista de espera ─────────────

/** Sube de la lista de espera (por orden de llegada) lo que entre en el cupo de cada fecha. */
export async function promoteWaitlist(eventId: number, at?: Date) {
  const db = tenantDb();
  const event = await db.calendarEvent.findFirst({ where: { id: eventId }, select: { capacity: true } });
  if (!event) return [];
  const waiting = await db.eventRegistration.findMany({
    where: { eventId, status: 'waitlist', ...(at ? { occurrenceStart: at } : {}) },
    select: { id: true, occurrenceStart: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const promoted: number[] = [];
  const byDate = new Map<number, number[]>();
  for (const w of waiting)
    byDate.set(w.occurrenceStart.getTime(), [...(byDate.get(w.occurrenceStart.getTime()) ?? []), w.id]);
  for (const [time, ids] of byDate) {
    const { confirmed } = await countsFor(eventId, new Date(time));
    const room = event.capacity === null ? ids.length : Math.max(event.capacity - confirmed, 0);
    const up = ids.slice(0, room);
    if (!up.length) continue;
    await db.eventRegistration.updateMany({
      where: { id: { in: up }, status: 'waitlist' },
      data: { status: 'confirmed' },
    });
    promoted.push(...up);
  }
  if (promoted.length) {
    await audit({
      action: 'calendar.registration.promote',
      entity: 'CalendarEvent',
      entityId: eventId,
      after: { ids: promoted },
    });
  }
  return promoted;
}

export async function cancelRegistration(id: number) {
  const db = tenantDb();
  const reg = await db.eventRegistration.findUnique({
    where: { id },
    select: { id: true, eventId: true, status: true, occurrenceStart: true },
  });
  if (!reg) throw AppError.notFound('REGISTRATION_NOT_FOUND');
  if (reg.status === 'cancelled') throw AppError.conflict('REGISTRATION_CANCELLED');
  await db.eventRegistration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
  await audit({
    action: 'calendar.registration.cancel',
    entity: 'EventRegistration',
    entityId: id,
    before: { status: reg.status },
  });
  const promoted = reg.status === 'confirmed' ? await promoteWaitlist(reg.eventId, reg.occurrenceStart) : [];
  return { promoted };
}

/**
 * Si cambió el horario o la regla del evento, cada inscripción pasa a la fecha del mismo día con el
 * horario nuevo. Las que ya no tienen fecha ese día quedan como estaban (se informan).
 */
export async function realignRegistrations(eventId: number, rule: string | null, start: Date, _end: Date) {
  const db = tenantDb();
  const regs = await db.eventRegistration.findMany({
    where: { eventId, status: { in: ACTIVE } },
    select: { id: true, occurrenceStart: true },
  });
  let orphans = 0;
  for (const r of regs) {
    const valid = rule
      ? isOccurrence(rule, start, r.occurrenceStart)
      : r.occurrenceStart.getTime() === start.getTime();
    if (valid) continue;
    const day = dateToLocal(r.occurrenceStart).slice(0, 10);
    const candidate = rule
      ? occurrences(rule, start, localToDate(`${day}T00:00`), localToDate(`${day}T23:59`))[0]
      : dateToLocal(start).slice(0, 10) === day
        ? start
        : undefined;
    if (candidate)
      await db.eventRegistration.update({ where: { id: r.id }, data: { occurrenceStart: candidate } });
    else orphans++;
  }
  return orphans;
}

// ───────────── Pago (manual) ─────────────

export const PaymentSchema = z
  .object({
    financeAccountId: z.number().int().positive(),
    amount: z.number().positive().max(999_999_999).optional(),
    paymentMethod: z.enum(['cash', 'transfer', 'card', 'wallet', 'other']).default('cash'),
    date: z.iso.date().optional(),
  })
  .strict();

/**
 * Registra lo que pagó la inscripción: un ingreso en la caja elegida (categoría de inscripciones a
 * eventos). Usa el alta de movimientos de finanzas, así respeta los meses cerrados y las cajas.
 */
export async function registerPayment(viewer: Viewer, id: number, input: z.infer<typeof PaymentSchema>) {
  if (!scopeOf(viewer, 'finanzas.registrar')) throw AppError.forbidden('PAYMENT_FORBIDDEN');
  const db = tenantDb();
  const reg = await db.eventRegistration.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      status: true,
      paidAmount: true,
      event: { select: { title: true, price: true } },
    },
  });
  if (!reg) throw AppError.notFound('REGISTRATION_NOT_FOUND');
  if (reg.status === 'cancelled') throw AppError.conflict('REGISTRATION_CANCELLED');
  const amount = input.amount ?? (reg.event.price === null ? null : Number(reg.event.price));
  if (!amount) throw AppError.badRequest('PAYMENT_AMOUNT_REQUIRED');
  const categoryId = await ensureSystemCategory('income', 'event_fees');
  const today = dateToLocal(await accountNow()).slice(0, 10);
  const movement = await createMovement(viewer, {
    kind: 'income',
    financeAccountId: input.financeAccountId,
    categoryId,
    date: input.date ?? today,
    amount,
    description: `${reg.event.title} · ${reg.name}`.slice(0, 300),
    paymentMethod: input.paymentMethod,
  });
  const paid = Math.round(((reg.paidAmount === null ? 0 : Number(reg.paidAmount)) + amount) * 100) / 100;
  await db.eventRegistration.update({
    where: { id },
    data: { paidAmount: paid, paymentMovementId: movement.id },
  });
  await audit({
    action: 'calendar.registration.payment',
    entity: 'EventRegistration',
    entityId: id,
    after: { amount, movementId: movement.id },
  });
  return { paidAmount: paid, movementId: movement.id };
}

// ───────────── Inscripción pública ─────────────

/** Evento público con sus próximas fechas y lugar disponible (para la página de inscripción). */
export async function publicEvent(eventId: number) {
  const event = await findEvent(eventId);
  if (!event.isPublic || !event.registrationEnabled) throw AppError.notFound('EVENT_NOT_FOUND');
  const full = await tenantDb().calendarEvent.findFirstOrThrow({
    where: { id: eventId },
    select: { description: true, location: true, allDay: true },
  });
  const now = await accountNow();
  const duration = event.endsAt.getTime() - event.startsAt.getTime();
  const starts = event.rrule
    ? occurrences(
        event.rrule,
        event.startsAt,
        new Date(now.getTime() - duration),
        new Date(now.getTime() + 120 * 86_400_000),
      ).slice(0, 12)
    : [event.startsAt];
  const exceptions = await tenantDb().eventException.findMany({
    where: { eventId, originalStart: { in: starts } },
  });
  const dates = [];
  for (const at of starts) {
    const x = exceptions.find((e) => e.originalStart.getTime() === at.getTime());
    if (x?.cancelled) continue;
    const start = x?.newStartsAt ?? at;
    const end = x?.newEndsAt ?? new Date(start.getTime() + duration);
    if (end <= now) continue;
    const a = availability(event, await countsFor(eventId, at));
    dates.push({
      occurrence: dateToLocal(at),
      startsAt: dateToLocal(start),
      endsAt: dateToLocal(end),
      full: a.full,
      waitlist: a.full && event.waitlistEnabled,
      available: a.available,
    });
  }
  return {
    id: event.id,
    title: event.title,
    description: full.description,
    location: full.location,
    allDay: full.allDay,
    price: event.price === null ? null : Number(event.price),
    dates,
  };
}
