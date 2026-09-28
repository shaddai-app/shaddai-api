import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import { toDate } from '../../core/time/local-date.js';
import { isoDate } from '../people/people.service.js';
import type { Viewer } from '../people/people.scope.js';
import {
  assertDate,
  categorySelect,
  ensureDefaultCategories,
  getMovement,
  movementSelect,
  optionalText,
  PAYMENT_METHODS,
  presentMovement,
  seesContributors,
  usableAccount,
  usableCategory,
} from './finance.service.js';
import { amount, Decimal, present, toMoney, ZERO, type Money } from './money.js';

// ═════════════ Ofrendas de célula (movimientos pendientes) ═════════════
//
// El líder carga la ofrenda en el reporte semanal; eso crea un ingreso "pending" sin caja (categoría
// Ofrendas). Tesorería lo confirma eligiendo la caja (y puede corregir el monto contado) o lo
// rechaza con motivo. Mientras está pendiente sigue al reporte; confirmado ya no se toca desde células.

type OfferingState = { held: boolean; offeringAmount: number | Money | null };

const offeringOf = (r: OfferingState) =>
  r.held && r.offeringAmount !== null && Number(r.offeringAmount) > 0 ? toMoney(r.offeringAmount) : null;

async function offeringCategoryId() {
  await ensureDefaultCategories();
  const category = await tenantDb().financeCategory.findFirst({
    where: { kind: 'income', systemKey: 'offering' },
    select: { id: true },
  });
  return category?.id ?? null;
}

/**
 * Antes de modificar o borrar un reporte: si tesorería ya confirmó la ofrenda, el líder no puede
 * cambiar lo informado ni sacarla (next = null: el reporte se borra). Se compara con lo informado y
 * no con lo confirmado, porque tesorería puede haber corregido el monto al contarlo.
 */
export async function assertOfferingChangeAllowed(
  reportId: number,
  previous: OfferingState,
  next: OfferingState | null,
) {
  const confirmed = await tenantDb().financeMovement.count({
    where: { cellReportId: reportId, status: 'confirmed' },
  });
  if (!confirmed) return;
  const before = offeringOf(previous);
  const after = next ? offeringOf(next) : null;
  if (!after || !before || !after.equals(before)) throw AppError.conflict('OFFERING_CONFIRMED');
}

/** Deja el movimiento pendiente de la ofrenda en línea con el reporte (crea, actualiza o borra). */
export async function syncCellOffering(
  viewer: Viewer,
  report: OfferingState & { id: number; meetingDate: string },
) {
  const db = tenantDb();
  const movements = await db.financeMovement.findMany({
    where: { cellReportId: report.id },
    select: { id: true, status: true, amount: true, date: true },
    orderBy: { id: 'desc' },
  });
  if (movements.some((m) => m.status === 'confirmed')) return;
  const value = offeringOf(report);
  const pending = movements.find((m) => m.status === 'pending');

  if (!value) {
    if (pending) {
      await db.financeMovement.delete({ where: { id: pending.id } });
      await audit({
        action: 'finance.pending.remove',
        entity: 'FinanceMovement',
        entityId: pending.id,
        before: { cellReportId: report.id, amount: present(pending.amount) },
      });
    }
    return;
  }
  if (pending) {
    if (!pending.amount.equals(value) || isoDate(pending.date) !== report.meetingDate) {
      await db.financeMovement.update({
        where: { id: pending.id },
        data: { amount: value, date: toDate(report.meetingDate) },
      });
    }
    return;
  }
  // Rechazada: solo vuelve a tesorería si el líder corrige el monto.
  const lastRejected = movements.find((m) => m.status === 'rejected');
  if (lastRejected?.amount.equals(value)) return;
  const created = await db.financeMovement.create({
    data: {
      accountId: currentAccountId(),
      financeAccountId: null,
      categoryId: await offeringCategoryId(),
      kind: 'income',
      date: toDate(report.meetingDate),
      amount: value,
      paymentMethod: 'cash',
      status: 'pending',
      cellReportId: report.id,
      createdById: viewer.userId,
    },
    select: { id: true },
  });
  await audit({
    action: 'finance.pending.create',
    entity: 'FinanceMovement',
    entityId: created.id,
    after: { cellReportId: report.id, amount: present(value) },
  });
}

/** Al borrar un reporte (ya validado con assertOfferingChangeAllowed) se van sus pendientes y rechazos. */
export async function releaseCellOffering(reportId: number) {
  await tenantDb().financeMovement.deleteMany({
    where: { cellReportId: reportId, status: { in: ['pending', 'rejected'] } },
  });
}

export const ListPendingQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'rejected']).default('pending'),
});

export async function listPending(viewer: Viewer, q: z.infer<typeof ListPendingQuery>) {
  const db = tenantDb();
  const where: Prisma.FinanceMovementWhereInput = { status: q.status };
  const [rows, total, sum] = await Promise.all([
    db.financeMovement.findMany({
      where,
      select: movementSelect,
      // Los pendientes, del más viejo al más nuevo (lo que hay que resolver primero); los rechazados al revés.
      orderBy: q.status === 'pending' ? [{ date: 'asc' }, { id: 'asc' }] : [{ voidedAt: 'desc' }],
      ...toSkipTake(q),
    }),
    db.financeMovement.count({ where }),
    db.financeMovement.aggregate({ where, _sum: { amount: true } }),
  ]);
  const { currency } = await db.account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { currency: true },
  });
  return {
    ...paged(
      rows.map((r) => presentMovement(r, viewer)),
      total,
      q,
    ),
    // Las ofrendas se cargan en la moneda de la iglesia.
    sum: { currency, amount: present(sum._sum.amount ?? ZERO) },
  };
}

export const ConfirmPendingSchema = z
  .object({
    financeAccountId: z.number().int().positive(),
    categoryId: z.number().int().positive().optional(),
    date: z.iso.date().optional(),
    /** Lo que realmente llegó (si difiere de lo informado queda auditado). */
    amount: amount.optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    description: optionalText(300),
    reference: optionalText(100),
  })
  .strict();

async function findPending(id: number) {
  const movement = await tenantDb().financeMovement.findUnique({ where: { id } });
  if (!movement) throw AppError.notFound('MOVEMENT_NOT_FOUND');
  if (movement.status !== 'pending') throw AppError.conflict('MOVEMENT_NOT_PENDING');
  return movement;
}

export async function confirmPending(
  viewer: Viewer,
  id: number,
  input: z.infer<typeof ConfirmPendingSchema>,
) {
  const movement = await findPending(id);
  const date = input.date ?? isoDate(movement.date)!;
  await assertDate(date);
  const account = await usableAccount(input.financeAccountId, date);
  const { currency } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { currency: true },
  });
  // El líder informó el monto en la moneda de la iglesia: no se convierte.
  if (account.currency !== currency) throw AppError.badRequest('FINANCE_CURRENCY_MISMATCH');
  const categoryId = input.categoryId ?? movement.categoryId ?? (await offeringCategoryId());
  if (!categoryId) throw AppError.badRequest('CATEGORY_INVALID');
  await usableCategory(categoryId, 'income');
  const value = input.amount !== undefined ? toMoney(input.amount) : movement.amount;
  const { count } = await tenantDb().financeMovement.updateMany({
    where: { id, status: 'pending' },
    data: {
      status: 'confirmed',
      financeAccountId: account.id,
      categoryId,
      date: toDate(date),
      amount: value,
      ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      confirmedAt: new Date(),
      confirmedById: viewer.userId,
    },
  });
  if (!count) throw AppError.conflict('MOVEMENT_NOT_PENDING'); // otro lo resolvió en el medio
  await audit({
    action: 'finance.pending.confirm',
    entity: 'FinanceMovement',
    entityId: id,
    before: { amount: present(movement.amount), date: isoDate(movement.date) },
    after: {
      amount: present(value),
      date,
      financeAccountId: account.id,
      difference: present(value.minus(movement.amount)),
    },
  });
  return getMovement(viewer, id);
}

export async function rejectPending(viewer: Viewer, id: number, reason: string) {
  await findPending(id);
  const { count } = await tenantDb().financeMovement.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'rejected', voidedAt: new Date(), voidedById: viewer.userId, voidReason: reason },
  });
  if (!count) throw AppError.conflict('MOVEMENT_NOT_PENDING');
  await audit({
    action: 'finance.pending.reject',
    entity: 'FinanceMovement',
    entityId: id,
    after: { reason },
  });
  return getMovement(viewer, id);
}

// ═════════════ Arqueos de culto ═════════════

const CountLineInput = z
  .object({
    categoryId: z.number().int().positive(),
    paymentMethod: z.enum(PAYMENT_METHODS),
    /** Billetes o monedas: denominación × cantidad (el monto lo calcula la API). */
    denomination: amount.nullable().optional(),
    quantity: z.number().int().positive().max(1_000_000).nullable().optional(),
    amount: amount.nullable().optional(),
    /** Sobre de diezmo con nombre. */
    personId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((l) => (l.denomination ? Boolean(l.quantity) : !l.quantity), {
    message: 'denomination and quantity go together',
  })
  .refine((l) => Boolean(l.denomination) || Boolean(l.amount), { message: 'amount required' })
  .refine((l) => !l.denomination || (l.paymentMethod === 'cash' && !l.personId), {
    message: 'denominations are for loose cash',
  });

const CountFields = z.object({
  date: z.iso.date(),
  financeAccountId: z.number().int().positive(),
  title: optionalText(100),
  counter1PersonId: z.number().int().positive(),
  counter2PersonId: z.number().int().positive(),
  notes: optionalText(500),
  lines: z.array(CountLineInput).max(300),
});

export const CreateCountSchema = CountFields.extend({ lines: CountFields.shape.lines.default([]) }).strict();
export const UpdateCountSchema = CountFields.partial().strict();

export const ListCountsQuery = PaginationQuery.extend({
  status: z.enum(['draft', 'confirmed', 'voided']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

type LineInput = z.infer<typeof CountLineInput>;

const personRef = { select: { id: true, firstName: true, lastName: true } } as const;

const countSelect = {
  id: true,
  date: true,
  title: true,
  status: true,
  notes: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  confirmedAt: true,
  confirmedById: true,
  voidedAt: true,
  voidReason: true,
  financeAccount: { select: { id: true, name: true, currency: true } },
  counter1: personRef,
  counter2: personRef,
} as const;

type CountRow = Prisma.OfferingCountGetPayload<{ select: typeof countSelect }>;

const presentCount = (c: CountRow, total: Money) => ({
  ...c,
  date: isoDate(c.date),
  total: present(total),
});

const lineAmount = (l: LineInput) =>
  l.denomination && l.quantity ? toMoney(l.denomination).times(l.quantity) : toMoney(l.amount!);

async function assertCountRefs(
  viewer: Viewer,
  input: {
    date: string;
    financeAccountId: number;
    counter1PersonId: number;
    counter2PersonId: number;
    lines: LineInput[];
  },
) {
  await assertDate(input.date);
  await usableAccount(input.financeAccountId, input.date);
  if (input.counter1PersonId === input.counter2PersonId) throw AppError.badRequest('COUNTERS_SAME');
  const db = tenantDb();
  const people = [
    ...new Set([
      input.counter1PersonId,
      input.counter2PersonId,
      ...input.lines.map((l) => l.personId).filter((v): v is number => Boolean(v)),
    ]),
  ];
  if (input.lines.some((l) => l.personId) && !seesContributors(viewer)) {
    throw AppError.forbidden('CONTRIBUTIONS_FORBIDDEN');
  }
  if ((await db.person.count({ where: { id: { in: people }, deletedAt: null } })) !== people.length) {
    throw AppError.badRequest('PERSON_INVALID');
  }
  const categoryIds = [...new Set(input.lines.map((l) => l.categoryId))];
  const categories = await db.financeCategory.findMany({ where: { id: { in: categoryIds } } });
  if (categories.length !== categoryIds.length) throw AppError.badRequest('CATEGORY_INVALID');
  if (categories.some((c) => c.kind !== 'income')) throw AppError.badRequest('CATEGORY_KIND_MISMATCH');
  if (categories.some((c) => !c.isActive)) throw AppError.conflict('CATEGORY_INACTIVE');
}

const lineRows = (lines: LineInput[]) =>
  lines.map((l, i) => ({
    categoryId: l.categoryId,
    paymentMethod: l.paymentMethod,
    denomination: l.denomination ? toMoney(l.denomination) : null,
    quantity: l.quantity ?? null,
    amount: lineAmount(l),
    personId: l.personId ?? null,
    sortOrder: i,
  }));

async function totalsOf(countIds: number[]) {
  const sums = await tenantDb().offeringCountLine.groupBy({
    by: ['countId'],
    where: { countId: { in: countIds } },
    _sum: { amount: true },
  });
  return new Map(sums.map((s) => [s.countId, s._sum.amount ?? ZERO]));
}

export async function listCounts(q: z.infer<typeof ListCountsQuery>) {
  const where: Prisma.OfferingCountWhereInput = {
    AND: [
      q.status ? { status: q.status } : {},
      q.from ? { date: { gte: toDate(q.from) } } : {},
      q.to ? { date: { lte: toDate(q.to) } } : {},
    ],
  };
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.offeringCount.findMany({
      where,
      select: countSelect,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      ...toSkipTake(q),
    }),
    db.offeringCount.count({ where }),
  ]);
  const totals = await totalsOf(rows.map((r) => r.id));
  return paged(
    rows.map((r) => presentCount(r, totals.get(r.id) ?? ZERO)),
    total,
    q,
  );
}

export async function getCount(viewer: Viewer, id: number) {
  const db = tenantDb();
  const row = await db.offeringCount.findUnique({ where: { id }, select: countSelect });
  if (!row) throw AppError.notFound('COUNT_NOT_FOUND');
  const lines = await db.offeringCountLine.findMany({
    where: { countId: id },
    select: {
      id: true,
      paymentMethod: true,
      denomination: true,
      quantity: true,
      amount: true,
      category: { select: categorySelect },
      person: personRef,
    },
    orderBy: { sortOrder: 'asc' },
  });
  const movements =
    row.status === 'draft'
      ? []
      : await db.financeMovement.findMany({
          where: { offeringCountId: id },
          select: movementSelect,
          orderBy: { id: 'asc' },
        });
  const users = await db.user.findMany({
    where: { id: { in: [row.createdById, row.confirmedById].filter((v): v is number => v !== null) } },
    select: { id: true, firstName: true, lastName: true },
  });
  const userOf = (userId: number | null) => users.find((u) => u.id === userId) ?? null;
  const sees = seesContributors(viewer);
  const total = lines.reduce((sum, l) => sum.plus(l.amount), ZERO);
  // Subtotales por medio de pago (lo que tiene que coincidir con el efectivo y los comprobantes).
  const byMethod = new Map<string, Money>();
  for (const l of lines)
    byMethod.set(l.paymentMethod, (byMethod.get(l.paymentMethod) ?? ZERO).plus(l.amount));
  return {
    ...presentCount(row, total),
    createdBy: userOf(row.createdById),
    confirmedBy: userOf(row.confirmedById),
    byPaymentMethod: [...byMethod.entries()].map(([paymentMethod, value]) => ({
      paymentMethod,
      amount: present(value),
    })),
    lines: lines.map(({ person, denomination, amount: value, ...l }) => ({
      ...l,
      denomination: present(denomination),
      amount: present(value),
      // Sin permiso de diezmos nominales se ve el sobre como "nominal", sin el nombre.
      nominal: person !== null,
      ...(sees ? { person } : {}),
    })),
    movements: movements.map((m) => presentMovement(m, viewer)),
  };
}

async function findDraft(id: number) {
  const count = await tenantDb().offeringCount.findUnique({ where: { id } });
  if (!count) throw AppError.notFound('COUNT_NOT_FOUND');
  if (count.status !== 'draft') throw AppError.conflict('COUNT_NOT_DRAFT');
  return count;
}

export async function createCount(viewer: Viewer, input: z.infer<typeof CreateCountSchema>) {
  await assertCountRefs(viewer, input);
  const created = await tenantDb().offeringCount.create({
    data: {
      accountId: currentAccountId(),
      date: toDate(input.date),
      financeAccountId: input.financeAccountId,
      title: input.title ?? null,
      counter1PersonId: input.counter1PersonId,
      counter2PersonId: input.counter2PersonId,
      notes: input.notes ?? null,
      createdById: viewer.userId,
      // Escritura anidada: los padres de los renglones ya se validaron en assertCountRefs.
      lines: { create: lineRows(input.lines) },
    },
    select: { id: true },
  });
  await audit({
    action: 'finance.count.create',
    entity: 'OfferingCount',
    entityId: created.id,
    after: { date: input.date, financeAccountId: input.financeAccountId, lines: input.lines.length },
  });
  return getCount(viewer, created.id);
}

export async function updateCount(viewer: Viewer, id: number, input: z.infer<typeof UpdateCountSchema>) {
  const before = await findDraft(id);
  const db = tenantDb();
  if (input.lines && !seesContributors(viewer)) {
    // Sin ver los sobres nominales, reemplazar los renglones los borraría sin saberlo.
    if (await db.offeringCountLine.count({ where: { countId: id, personId: { not: null } } })) {
      throw AppError.forbidden('CONTRIBUTIONS_FORBIDDEN');
    }
  }
  await assertCountRefs(viewer, {
    date: input.date ?? isoDate(before.date)!,
    financeAccountId: input.financeAccountId ?? before.financeAccountId,
    counter1PersonId: input.counter1PersonId ?? before.counter1PersonId,
    counter2PersonId: input.counter2PersonId ?? before.counter2PersonId,
    lines: input.lines ?? [],
  });
  const { lines, date, ...rest } = input;
  await db.offeringCount.update({
    where: { id },
    data: {
      ...rest,
      ...(date ? { date: toDate(date) } : {}),
      ...(lines ? { lines: { deleteMany: {}, create: lineRows(lines) } } : {}),
    },
  });
  await audit({
    action: 'finance.count.update',
    entity: 'OfferingCount',
    entityId: id,
    after: { changed: Object.keys(input) },
  });
  return getCount(viewer, id);
}

export async function deleteCount(id: number) {
  const count = await findDraft(id);
  await tenantDb().offeringCount.delete({ where: { id } });
  await audit({
    action: 'finance.count.delete',
    entity: 'OfferingCount',
    entityId: id,
    before: { date: isoDate(count.date), financeAccountId: count.financeAccountId },
  });
}

/**
 * Confirma el arqueo y genera los ingresos en la caja: uno por categoría y medio de pago con lo
 * suelto, y uno por cada sobre nominal (así el aporte queda a nombre de la persona).
 */
export async function confirmCount(viewer: Viewer, id: number) {
  const count = await findDraft(id);
  const db = tenantDb();
  const lines = await db.offeringCountLine.findMany({
    where: { countId: id },
    orderBy: { sortOrder: 'asc' },
  });
  if (lines.length === 0) throw AppError.conflict('COUNT_EMPTY');
  const date = isoDate(count.date)!;
  // Se revalida: la caja o las categorías pueden haberse desactivado desde que se cargó el borrador.
  await usableAccount(count.financeAccountId, date);
  for (const categoryId of new Set(lines.map((l) => l.categoryId)))
    await usableCategory(categoryId, 'income');

  const loose = new Map<string, { categoryId: number; paymentMethod: string; amount: Money }>();
  const envelopes: { categoryId: number; paymentMethod: string; amount: Money; personId: number }[] = [];
  for (const l of lines) {
    if (l.personId) {
      envelopes.push({
        categoryId: l.categoryId,
        paymentMethod: l.paymentMethod,
        amount: l.amount,
        personId: l.personId,
      });
      continue;
    }
    const key = `${l.categoryId}:${l.paymentMethod}`;
    const group = loose.get(key) ?? {
      categoryId: l.categoryId,
      paymentMethod: l.paymentMethod,
      amount: ZERO,
    };
    group.amount = group.amount.plus(l.amount);
    loose.set(key, group);
  }
  const base = {
    accountId: currentAccountId(),
    financeAccountId: count.financeAccountId,
    kind: 'income',
    date: toDate(date),
    description: count.title,
    offeringCountId: id,
    createdById: viewer.userId,
  };
  const movements = [
    ...[...loose.values()].map((g) => ({ ...base, ...g })),
    ...envelopes.map((e) => ({ ...base, ...e })),
  ];
  const total = lines.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));

  await db.$transaction(async (tx) => {
    const { count: updated } = await tx.offeringCount.updateMany({
      where: { id, status: 'draft' },
      data: { status: 'confirmed', confirmedAt: new Date(), confirmedById: viewer.userId },
    });
    if (!updated) throw AppError.conflict('COUNT_NOT_DRAFT'); // otro lo confirmó en el medio
    await tx.financeMovement.createMany({ data: movements });
  });
  await audit({
    action: 'finance.count.confirm',
    entity: 'OfferingCount',
    entityId: id,
    after: { total: present(total), movements: movements.length, financeAccountId: count.financeAccountId },
  });
  return getCount(viewer, id);
}

/** Anula un arqueo confirmado y todos sus movimientos (se vuelve a cargar si hace falta). */
export async function voidCount(viewer: Viewer, id: number, reason: string) {
  const db = tenantDb();
  const count = await db.offeringCount.findUnique({ where: { id } });
  if (!count) throw AppError.notFound('COUNT_NOT_FOUND');
  if (count.status !== 'confirmed') throw AppError.conflict('COUNT_NOT_CONFIRMED');
  const now = new Date();
  const voided = { voidedAt: now, voidedById: viewer.userId, voidReason: reason };
  await db.$transaction(async (tx) => {
    await tx.offeringCount.update({ where: { id }, data: { status: 'voided', ...voided } });
    await tx.financeMovement.updateMany({
      where: { offeringCountId: id, status: 'confirmed' },
      data: { status: 'voided', ...voided },
    });
  });
  await audit({ action: 'finance.count.void', entity: 'OfferingCount', entityId: id, after: { reason } });
  return getCount(viewer, id);
}
