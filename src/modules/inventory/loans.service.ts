import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import { daysBetween, todayIn, toDate } from '../../core/time/local-date.js';
import { fold, isoDate } from '../people/people.service.js';
import type { Viewer } from '../people/people.scope.js';
import { ITEM_STATUSES } from './constants.js';

// Préstamos de equipos. Las fechas son días de la iglesia: un préstamo vence cuando termina el día
// dueAt (a partir del día siguiente está vencido). Un equipo tiene como mucho un préstamo abierto.

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const CreateLoanSchema = z
  .object({
    itemId: z.number().int().positive(),
    borrowerPersonId: z.number().int().positive(),
    borrowedAt: z.iso.date().optional(), // por defecto, hoy
    dueAt: z.iso.date(),
    conditionOut: optionalText(200),
    notes: optionalText(500),
  })
  .strict();

export const UpdateLoanSchema = z
  .object({ dueAt: z.iso.date(), notes: optionalText(500) })
  .partial()
  .strict();

export const ReturnLoanSchema = z
  .object({
    conditionIn: optionalText(200),
    // Opcional: el equipo vuelve con falla, por ejemplo.
    status: z.enum(ITEM_STATUSES).exclude(['retired']).optional(),
  })
  .strict();

export const LOAN_STATES = ['open', 'overdue', 'returned', 'all'] as const;

export const ListLoansQuery = PaginationQuery.extend({
  state: z.enum(LOAN_STATES).default('open'),
  q: z.string().trim().max(100).optional(),
  itemId: z.coerce.number().int().positive().optional(),
  personId: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function accountToday() {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  return todayIn(timezone);
}

const loanSelect = {
  id: true,
  borrowedAt: true,
  dueAt: true,
  returnedAt: true,
  conditionOut: true,
  conditionIn: true,
  notes: true,
  createdAt: true,
  item: { select: { id: true, code: true, name: true, status: true, deletedAt: true } },
  borrower: { select: { id: true, firstName: true, lastName: true, phone: true, photoFileId: true } },
} as const;

type LoanRow = Prisma.InventoryLoanGetPayload<{ select: typeof loanSelect }>;

function present(row: LoanRow, today: string) {
  const { item, borrowedAt, dueAt, ...rest } = row;
  const due = isoDate(dueAt)!;
  const late = row.returnedAt === null ? daysBetween(due, today) : 0;
  return {
    ...rest,
    borrowedAt: isoDate(borrowedAt)!,
    dueAt: due,
    overdue: late > 0,
    daysOverdue: Math.max(0, late),
    item: {
      id: item.id,
      code: item.code,
      name: item.name,
      status: item.status,
      deleted: item.deletedAt !== null,
    },
  };
}

/** Préstamo abierto por equipo (para marcar "prestado" en la lista y en la ficha). */
export async function openLoansFor(itemIds: number[], today: string) {
  if (!itemIds.length) return new Map<number, { dueAt: string; overdue: boolean }>();
  const rows = await tenantDb().inventoryLoan.findMany({
    where: { itemId: { in: itemIds }, returnedAt: null },
    select: { itemId: true, dueAt: true },
  });
  return new Map(
    rows.map((r) => {
      const dueAt = isoDate(r.dueAt)!;
      return [r.itemId, { dueAt, overdue: dueAt < today }];
    }),
  );
}

export async function listLoans(q: z.infer<typeof ListLoansQuery>) {
  const today = await accountToday();
  const words = fold(q.q).split(' ').filter(Boolean);
  const base: Prisma.InventoryLoanWhereInput[] = [
    ...(q.itemId ? [{ itemId: q.itemId }] : []),
    ...(q.personId ? [{ borrowerPersonId: q.personId }] : []),
    // Cada palabra en el equipo (nombre, código, marca…) o en la persona.
    ...words.map((w) => ({
      OR: [{ item: { searchText: { contains: w } } }, { borrower: { searchText: { contains: w } } }],
    })),
  ];
  const state: Record<(typeof LOAN_STATES)[number], Prisma.InventoryLoanWhereInput> = {
    open: { returnedAt: null },
    overdue: { returnedAt: null, dueAt: { lt: toDate(today) } },
    returned: { returnedAt: { not: null } },
    all: {},
  };
  const where: Prisma.InventoryLoanWhereInput = { AND: [...base, state[q.state]] };
  const db = tenantDb();
  const [rows, total, open, overdue] = await Promise.all([
    db.inventoryLoan.findMany({
      where,
      select: loanSelect,
      // Abiertos: primero los que vencen antes. Devueltos: los más recientes.
      orderBy:
        q.state === 'returned' || q.state === 'all'
          ? [{ borrowedAt: 'desc' }, { id: 'desc' }]
          : [{ dueAt: 'asc' }, { id: 'asc' }],
      ...toSkipTake(q),
    }),
    db.inventoryLoan.count({ where }),
    db.inventoryLoan.count({ where: { AND: [...base, state.open] } }),
    db.inventoryLoan.count({ where: { AND: [...base, state.overdue] } }),
  ]);
  return {
    ...paged(
      rows.map((r) => present(r, today)),
      total,
      q,
    ),
    counts: { open, overdue },
  };
}

async function findLoan(id: number) {
  const row = await tenantDb().inventoryLoan.findFirst({ where: { id }, select: loanSelect });
  if (!row) throw AppError.notFound('LOAN_NOT_FOUND');
  return row;
}

export async function getLoan(id: number) {
  return present(await findLoan(id), await accountToday());
}

export async function createLoan(viewer: Viewer, input: z.infer<typeof CreateLoanSchema>) {
  const today = await accountToday();
  const borrowedAt = input.borrowedAt ?? today;
  if (borrowedAt > today) throw AppError.badRequest('LOAN_DATE_INVALID');
  if (input.dueAt < borrowedAt) throw AppError.badRequest('LOAN_DUE_INVALID');
  const db = tenantDb();
  if (!(await db.person.count({ where: { id: input.borrowerPersonId, deletedAt: null } }))) {
    throw AppError.badRequest('PERSON_INVALID');
  }
  // Serializable: dos préstamos simultáneos del mismo equipo no pueden pasar los dos el control.
  const created = await db.$transaction(
    async (tx) => {
      const item = await tx.inventoryItem.findFirst({
        where: { id: input.itemId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!item) throw AppError.notFound('INVENTORY_ITEM_NOT_FOUND');
      if (item.status === 'retired' || item.status === 'repair') {
        throw AppError.conflict('INVENTORY_ITEM_UNAVAILABLE');
      }
      const open = await tx.inventoryLoan.findFirst({
        where: { itemId: item.id, returnedAt: null },
        select: { id: true },
      });
      if (open) throw AppError.conflict('INVENTORY_ITEM_ON_LOAN', { id: open.id });
      return tx.inventoryLoan.create({
        data: {
          accountId: currentAccountId(),
          itemId: item.id,
          borrowerPersonId: input.borrowerPersonId,
          borrowedAt: toDate(borrowedAt),
          dueAt: toDate(input.dueAt),
          conditionOut: input.conditionOut ?? null,
          notes: input.notes ?? null,
          createdById: viewer.userId,
        },
        select: { id: true },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  await audit({
    action: 'inventory.loan.create',
    entity: 'InventoryLoan',
    entityId: created.id,
    after: { itemId: input.itemId, personId: input.borrowerPersonId, borrowedAt, dueAt: input.dueAt },
  });
  return getLoan(created.id);
}

export async function updateLoan(id: number, input: z.infer<typeof UpdateLoanSchema>) {
  const loan = await findLoan(id);
  if (loan.returnedAt) throw AppError.conflict('LOAN_ALREADY_RETURNED');
  if (input.dueAt && input.dueAt < isoDate(loan.borrowedAt)!) throw AppError.badRequest('LOAN_DUE_INVALID');
  await tenantDb().inventoryLoan.update({
    where: { id },
    data: {
      ...(input.dueAt ? { dueAt: toDate(input.dueAt) } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  await audit({
    action: 'inventory.loan.update',
    entity: 'InventoryLoan',
    entityId: id,
    before: { dueAt: isoDate(loan.dueAt) },
    after: { changed: Object.keys(input), dueAt: input.dueAt },
  });
  return getLoan(id);
}

export async function returnLoan(viewer: Viewer, id: number, input: z.infer<typeof ReturnLoanSchema>) {
  const loan = await findLoan(id);
  if (loan.returnedAt) throw AppError.conflict('LOAN_ALREADY_RETURNED');
  const db = tenantDb();
  await db.$transaction(async (tx) => {
    await tx.inventoryLoan.update({
      where: { id },
      data: { returnedAt: new Date(), conditionIn: input.conditionIn ?? null, returnedById: viewer.userId },
    });
    if (input.status && input.status !== loan.item.status && !loan.item.deletedAt) {
      await tx.inventoryItem.update({ where: { id: loan.item.id }, data: { status: input.status } });
    }
  });
  await audit({
    action: 'inventory.loan.return',
    entity: 'InventoryLoan',
    entityId: id,
    after: { itemId: loan.item.id, status: input.status ?? loan.item.status },
  });
  return getLoan(id);
}

/** Para corregir un préstamo cargado por error (el historial de devoluciones se conserva en auditoría). */
export async function deleteLoan(id: number) {
  const loan = await findLoan(id);
  await tenantDb().inventoryLoan.delete({ where: { id } });
  await audit({
    action: 'inventory.loan.delete',
    entity: 'InventoryLoan',
    entityId: id,
    before: {
      itemId: loan.item.id,
      personId: loan.borrower.id,
      borrowedAt: isoDate(loan.borrowedAt),
      dueAt: isoDate(loan.dueAt),
      returned: loan.returnedAt !== null,
    },
  });
}

export const BorrowersQuery = z.object({ q: z.string().trim().min(2).max(100) });

/**
 * Personas para elegir a quién se presta. Quien presta equipos no necesariamente ve personas
 * (personas.ver): solo recibe nombre y teléfono de las coincidencias, hasta 15.
 */
export async function searchBorrowers(q: string) {
  const words = fold(q).split(' ').filter(Boolean);
  const items = await tenantDb().person.findMany({
    where: { deletedAt: null, AND: words.map((w) => ({ searchText: { contains: w } })) },
    select: { id: true, firstName: true, lastName: true, phone: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 15,
  });
  return { items };
}
