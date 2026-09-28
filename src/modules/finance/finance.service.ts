import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import { toDate, todayIn } from '../../core/time/local-date.js';
import { fold, isoDate } from '../people/people.service.js';
import { scopeOf, type Viewer } from '../people/people.scope.js';
import { amount, INFLOW, present, signedAmount, toMoney, ZERO, type Money } from './money.js';
import { assertPeriodOpen, lastClosedDay } from './period-lock.js';

// ───────────── Constantes ─────────────

export const ACCOUNT_TYPES = ['cash', 'bank', 'wallet'] as const;
export const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'wallet', 'other'] as const;
export const CATEGORY_KINDS = ['income', 'expense'] as const;
export const MOVEMENT_KINDS = ['income', 'expense', 'transfer_in', 'transfer_out'] as const;

/** Categorías con las que arranca cada iglesia (renombrables; name null = traducido por systemKey). */
export const DEFAULT_CATEGORIES: Record<(typeof CATEGORY_KINDS)[number], string[]> = {
  income: ['tithe', 'offering', 'special_offering', 'donation', 'other_income'],
  expense: [
    'rent',
    'utilities',
    'maintenance',
    'salaries',
    'missions',
    'social_aid',
    'supplies',
    'events',
    'other_expense',
  ],
};

type Db = ReturnType<typeof tenantDb> | Prisma.TransactionClient;

export async function accountToday() {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  return todayIn(timezone);
}

/** El aportante (diezmo nominal) solo lo ve y lo carga quien tiene finanzas.diezmos_nominales. */
export const seesContributors = (viewer: Viewer) => Boolean(scopeOf(viewer, 'finanzas.diezmos_nominales'));

// ───────────── Categorías ─────────────

export async function ensureDefaultCategories(db: Db = tenantDb()) {
  if ((await db.financeCategory.count()) > 0) return;
  await db.financeCategory.createMany({
    data: CATEGORY_KINDS.flatMap((kind) =>
      DEFAULT_CATEGORIES[kind].map((systemKey, i) => ({
        accountId: currentAccountId(),
        kind,
        systemKey,
        sortOrder: (i + 1) * 10,
      })),
    ),
  });
}

export const categorySelect = {
  id: true,
  kind: true,
  systemKey: true,
  name: true,
  sortOrder: true,
  isActive: true,
} as const;

export async function listCategories(query: { kind?: 'income' | 'expense'; includeInactive: boolean }) {
  await ensureDefaultCategories();
  return tenantDb().financeCategory.findMany({
    where: {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.includeInactive ? {} : { isActive: true }),
    },
    select: categorySelect,
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  });
}

export const CategoryInput = z
  .object({
    kind: z.enum(CATEGORY_KINDS),
    name: z.string().trim().min(1).max(100).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

export async function createCategory(input: { kind: 'income' | 'expense'; name: string }) {
  await ensureDefaultCategories();
  const db = tenantDb();
  const last = await db.financeCategory.aggregate({ where: { kind: input.kind }, _max: { sortOrder: true } });
  const category = await db.financeCategory.create({
    data: {
      accountId: currentAccountId(),
      kind: input.kind,
      name: input.name,
      sortOrder: (last._max.sortOrder ?? 0) + 10,
    },
    select: categorySelect,
  });
  await audit({
    action: 'finance.category.create',
    entity: 'FinanceCategory',
    entityId: category.id,
    after: category,
  });
  return category;
}

export async function updateCategory(id: number, input: { name?: string | null; isActive?: boolean }) {
  const db = tenantDb();
  const before = await db.financeCategory.findUnique({ where: { id }, select: categorySelect });
  if (!before) throw AppError.notFound('CATALOG_ITEM_NOT_FOUND');
  // Una categoría propia necesita nombre; una del sistema sin nombre vuelve a la traducción.
  if (input.name === null && !before.systemKey) throw AppError.badRequest('CATALOG_NAME_REQUIRED');
  const category = await db.financeCategory.update({ where: { id }, data: input, select: categorySelect });
  await audit({
    action: 'finance.category.update',
    entity: 'FinanceCategory',
    entityId: id,
    before,
    after: category,
  });
  return category;
}

export async function reorderCategories(ids: number[]) {
  const db = tenantDb();
  const unique = [...new Set(ids)];
  const rows = await db.financeCategory.findMany({ where: { id: { in: unique } }, select: { kind: true } });
  if (rows.length !== unique.length || new Set(rows.map((r) => r.kind)).size !== 1) {
    throw AppError.badRequest('CATALOG_ITEM_INVALID');
  }
  await db.$transaction(
    unique.map((id, i) => db.financeCategory.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } })),
  );
}

export async function deleteCategory(id: number) {
  const db = tenantDb();
  const category = await db.financeCategory.findUnique({ where: { id } });
  if (!category) throw AppError.notFound('CATALOG_ITEM_NOT_FOUND');
  if (category.systemKey) throw AppError.conflict('CATALOG_SYSTEM_ITEM');
  if (await db.financeMovement.count({ where: { categoryId: id } }))
    throw AppError.conflict('CATALOG_IN_USE');
  await db.financeCategory.delete({ where: { id } });
  await audit({
    action: 'finance.category.delete',
    entity: 'FinanceCategory',
    entityId: id,
    before: category,
  });
}

// ───────────── Cajas y saldos ─────────────

export const AccountInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(ACCOUNT_TYPES),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((c) => c.toUpperCase()),
    openingBalance: signedAmount,
    openingDate: z.iso.date(),
    campusId: z.number().int().positive().nullable(),
    responsibleUserId: z.number().int().positive().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

const accountSelect = {
  id: true,
  name: true,
  type: true,
  currency: true,
  openingBalance: true,
  openingDate: true,
  isActive: true,
  campus: { select: { id: true, name: true } },
  responsible: { select: { id: true, firstName: true, lastName: true } },
} as const;

/**
 * Saldo por caja: apertura + ingresos y transferencias recibidas − egresos y transferencias enviadas.
 * Solo cuentan los movimientos confirmados (ni los anulados ni los pendientes ni los rechazados).
 */
export async function balances(accountIds?: number[], asOf?: string): Promise<Map<number, Money>> {
  const db = tenantDb();
  const accounts = await db.financeAccount.findMany({
    where: accountIds ? { id: { in: accountIds } } : {},
    select: { id: true, openingBalance: true },
  });
  const sums = await db.financeMovement.groupBy({
    by: ['financeAccountId', 'kind'],
    where: {
      status: 'confirmed',
      financeAccountId: { in: accounts.map((a) => a.id) },
      ...(asOf ? { date: { lte: toDate(asOf) } } : {}),
    },
    _sum: { amount: true },
  });
  const result = new Map(accounts.map((a) => [a.id, toMoney(a.openingBalance)]));
  for (const s of sums) {
    if (s.financeAccountId === null) continue; // no pasa: los confirmados siempre tienen caja
    const value = s._sum.amount ?? ZERO;
    const current = result.get(s.financeAccountId) ?? ZERO;
    result.set(s.financeAccountId, INFLOW.has(s.kind) ? current.plus(value) : current.minus(value));
  }
  return result;
}

type AccountRow = Prisma.FinanceAccountGetPayload<{ select: typeof accountSelect }>;
const presentAccount = (a: AccountRow, balance: Money | undefined) => ({
  ...a,
  openingBalance: present(a.openingBalance),
  openingDate: isoDate(a.openingDate),
  balance: present(balance ?? a.openingBalance),
});

export async function listAccounts(includeInactive: boolean) {
  const rows = await tenantDb().financeAccount.findMany({
    where: includeInactive ? {} : { isActive: true },
    select: accountSelect,
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  const bal = await balances(rows.map((r) => r.id));
  return rows.map((r) => presentAccount(r, bal.get(r.id)));
}

async function getAccount(id: number) {
  const row = await tenantDb().financeAccount.findUnique({ where: { id }, select: accountSelect });
  if (!row) throw AppError.notFound('FINANCE_ACCOUNT_NOT_FOUND');
  return presentAccount(row, (await balances([id])).get(id));
}

/**
 * El saldo inicial cuenta en todos los meses desde la apertura: no se crea una caja ni se cambia su
 * apertura dentro de un período ya cerrado (cambiaría saldos cerrados).
 */
async function assertOpeningEditable(...dates: (string | undefined)[]) {
  const last = await lastClosedDay();
  const first = dates.filter((d): d is string => Boolean(d)).sort()[0];
  if (last && first && first <= last) throw AppError.conflict('PERIOD_CLOSED', { until: last });
}
async function assertAccountRefs(input: { campusId?: number | null; responsibleUserId?: number | null }) {
  const db = tenantDb();
  if (input.campusId && !(await db.campus.count({ where: { id: input.campusId } }))) {
    throw AppError.badRequest('CAMPUS_INVALID');
  }
  if (
    input.responsibleUserId &&
    !(await db.user.count({ where: { id: input.responsibleUserId, isActive: true, deletedAt: null } }))
  ) {
    throw AppError.badRequest('USER_INVALID');
  }
}

export async function createAccount(input: z.infer<typeof AccountInput> & { name: string; type: string }) {
  await assertAccountRefs(input);
  const db = tenantDb();
  const today = await accountToday();
  const { currency: defaultCurrency } = await db.account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { currency: true },
  });
  const openingDate = input.openingDate ?? today;
  await assertOpeningEditable(openingDate);
  if (openingDate > today) throw AppError.badRequest('DATE_IN_FUTURE');
  const created = await db.financeAccount.create({
    data: {
      accountId: currentAccountId(),
      name: input.name,
      type: input.type,
      currency: input.currency ?? defaultCurrency,
      openingBalance: toMoney(input.openingBalance ?? 0),
      openingDate: toDate(openingDate),
      campusId: input.campusId ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
    },
    select: { id: true },
  });
  const account = await getAccount(created.id);
  await audit({
    action: 'finance.account.create',
    entity: 'FinanceAccount',
    entityId: created.id,
    after: account,
  });
  return account;
}

export async function updateAccount(id: number, input: z.infer<typeof AccountInput>) {
  const db = tenantDb();
  const before = await db.financeAccount.findUnique({ where: { id } });
  if (!before) throw AppError.notFound('FINANCE_ACCOUNT_NOT_FOUND');
  await assertAccountRefs(input);
  const movements = await db.financeMovement.aggregate({
    where: { financeAccountId: id },
    _min: { date: true },
    _count: true,
  });
  // Con movimientos, cambiar la moneda cambiaría el sentido de todos los montos.
  if (input.currency && input.currency !== before.currency && movements._count > 0) {
    throw AppError.conflict('FINANCE_CURRENCY_LOCKED');
  }
  const openingChanged =
    (input.openingBalance !== undefined && !toMoney(input.openingBalance).equals(before.openingBalance)) ||
    (input.openingDate !== undefined && input.openingDate !== isoDate(before.openingDate));
  if (openingChanged) await assertOpeningEditable(isoDate(before.openingDate)!, input.openingDate);
  if (input.openingDate) {
    if (input.openingDate > (await accountToday())) throw AppError.badRequest('DATE_IN_FUTURE');
    const first = isoDate(movements._min.date);
    if (first && input.openingDate > first)
      throw AppError.conflict('FINANCE_OPENING_AFTER_MOVEMENTS', { first });
  }
  const { openingBalance, openingDate, ...rest } = input;
  await db.financeAccount.update({
    where: { id },
    data: {
      ...rest,
      ...(openingBalance !== undefined ? { openingBalance: toMoney(openingBalance) } : {}),
      ...(openingDate ? { openingDate: toDate(openingDate) } : {}),
    },
  });
  const account = await getAccount(id);
  await audit({
    action: 'finance.account.update',
    entity: 'FinanceAccount',
    entityId: id,
    before: { ...before, openingBalance: present(before.openingBalance) },
    after: account,
  });
  return account;
}

export async function deleteAccount(id: number) {
  const db = tenantDb();
  const account = await db.financeAccount.findUnique({ where: { id } });
  if (!account) throw AppError.notFound('FINANCE_ACCOUNT_NOT_FOUND');
  // Con historia no se borra: se desactiva (el saldo y los reportes la siguen necesitando).
  if (await db.financeMovement.count({ where: { financeAccountId: id } })) {
    throw AppError.conflict('FINANCE_ACCOUNT_IN_USE');
  }
  await db.financeAccount.delete({ where: { id } });
  await audit({
    action: 'finance.account.delete',
    entity: 'FinanceAccount',
    entityId: id,
    before: { name: account.name },
  });
}

// ───────────── Movimientos ─────────────

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const MovementFields = z.object({
  financeAccountId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  date: z.iso.date(),
  amount,
  description: optionalText(300),
  personId: z.number().int().positive().nullable().optional(),
  isAnonymous: z.boolean().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  reference: optionalText(100),
});

export const CreateMovementSchema = MovementFields.extend({ kind: z.enum(CATEGORY_KINDS) }).strict();
export const UpdateMovementSchema = MovementFields.partial().strict();

export const TransferSchema = z
  .object({
    fromAccountId: z.number().int().positive(),
    toAccountId: z.number().int().positive(),
    date: z.iso.date(),
    amount,
    description: optionalText(300),
    reference: optionalText(100),
  })
  .strict();

export const ListMovementsQuery = PaginationQuery.extend({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  financeAccountId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  kind: z.enum([...MOVEMENT_KINDS, 'transfer']).optional(),
  status: z.enum(['confirmed', 'voided']).optional(),
  personId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
});

export const movementSelect = {
  id: true,
  kind: true,
  date: true,
  amount: true,
  description: true,
  isAnonymous: true,
  paymentMethod: true,
  reference: true,
  status: true,
  transferPairId: true,
  confirmedAt: true,
  voidedAt: true,
  voidReason: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  financeAccount: { select: { id: true, name: true, currency: true } },
  category: { select: { id: true, kind: true, systemKey: true, name: true } },
  person: { select: { id: true, firstName: true, lastName: true } },
  cellReport: { select: { id: true, meetingDate: true, cell: { select: { id: true, name: true } } } },
  offeringCount: { select: { id: true, title: true } },
  _count: { select: { attachments: true } },
} as const;

type MovementRow = Prisma.FinanceMovementGetPayload<{ select: typeof movementSelect }>;

export function presentMovement(row: MovementRow, viewer: Viewer) {
  const { amount: value, date, person, _count, cellReport, ...rest } = row;
  return {
    ...rest,
    cellReport: cellReport && { ...cellReport, meetingDate: isoDate(cellReport.meetingDate) },
    date: isoDate(date),
    amount: present(value),
    attachmentCount: _count.attachments,
    // Sin permiso de diezmos nominales el aportante no viaja en la respuesta (ni su existencia).
    ...(seesContributors(viewer) ? { person } : {}),
  };
}

function movementWhere(
  viewer: Viewer,
  q: z.infer<typeof ListMovementsQuery>,
): Prisma.FinanceMovementWhereInput {
  if (q.personId && !seesContributors(viewer)) throw AppError.forbidden('CONTRIBUTIONS_FORBIDDEN');
  const and: Prisma.FinanceMovementWhereInput[] = [];
  if (q.from) and.push({ date: { gte: toDate(q.from) } });
  if (q.to) and.push({ date: { lte: toDate(q.to) } });
  if (q.financeAccountId) and.push({ financeAccountId: q.financeAccountId });
  if (q.categoryId) and.push({ categoryId: q.categoryId });
  if (q.kind === 'transfer') and.push({ kind: { in: ['transfer_in', 'transfer_out'] } });
  else if (q.kind) and.push({ kind: q.kind });
  and.push({ status: q.status ?? 'confirmed' });
  if (q.personId) and.push({ personId: q.personId });
  for (const token of (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5)) {
    const or: Prisma.FinanceMovementWhereInput[] = [
      { description: { contains: token } },
      { reference: { contains: token } },
    ];
    if (seesContributors(viewer)) or.push({ person: { searchText: { contains: fold(token) } } });
    and.push({ OR: or });
  }
  return { AND: and };
}

/** Totales de ingresos y egresos del filtro, por moneda (las transferencias no son ingreso ni egreso). */
async function totalsByCurrency(where: Prisma.FinanceMovementWhereInput) {
  const db = tenantDb();
  const sums = (
    await db.financeMovement.groupBy({
      by: ['financeAccountId', 'kind'],
      where: { AND: [where, { kind: { in: ['income', 'expense'] } }, { financeAccountId: { not: null } }] },
      _sum: { amount: true },
    })
  ).filter((s): s is typeof s & { financeAccountId: number } => s.financeAccountId !== null);
  const accounts = await db.financeAccount.findMany({
    where: { id: { in: [...new Set(sums.map((s) => s.financeAccountId))] } },
    select: { id: true, currency: true },
  });
  const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
  const totals = new Map<string, { income: Money; expense: Money }>();
  for (const s of sums) {
    const currency = currencyOf.get(s.financeAccountId)!;
    const t = totals.get(currency) ?? { income: ZERO, expense: ZERO };
    const value = s._sum.amount ?? ZERO;
    if (s.kind === 'income') t.income = t.income.plus(value);
    else t.expense = t.expense.plus(value);
    totals.set(currency, t);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      income: present(t.income),
      expense: present(t.expense),
      net: present(t.income.minus(t.expense)),
    }));
}

export async function listMovements(viewer: Viewer, q: z.infer<typeof ListMovementsQuery>) {
  const where = movementWhere(viewer, q);
  const db = tenantDb();
  const [rows, total, totals] = await Promise.all([
    db.financeMovement.findMany({
      where,
      select: movementSelect,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      ...toSkipTake(q),
    }),
    db.financeMovement.count({ where }),
    totalsByCurrency(where),
  ]);
  return {
    ...paged(
      rows.map((r) => presentMovement(r, viewer)),
      total,
      q,
    ),
    totals,
  };
}

export async function getMovement(viewer: Viewer, id: number) {
  const db = tenantDb();
  const row = await db.financeMovement.findUnique({ where: { id }, select: movementSelect });
  if (!row) throw AppError.notFound('MOVEMENT_NOT_FOUND');
  const attachments = await db.movementAttachment.findMany({
    where: { movementId: id },
    select: {
      file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true, deletedAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const creator = await db.user.findUnique({
    where: { id: row.createdById },
    select: { id: true, firstName: true, lastName: true },
  });
  return {
    ...presentMovement(row, viewer),
    createdBy: creator,
    attachments: attachments.filter((a) => !a.file.deletedAt).map(({ file: { deletedAt: _d, ...f } }) => f),
  };
}

// ── Validaciones de referencias (siempre dentro de la cuenta) ──

export async function usableAccount(id: number, date: string) {
  const account = await tenantDb().financeAccount.findUnique({ where: { id } });
  if (!account) throw AppError.badRequest('FINANCE_ACCOUNT_INVALID');
  if (!account.isActive) throw AppError.conflict('FINANCE_ACCOUNT_INACTIVE');
  if (date < isoDate(account.openingDate)!) {
    throw AppError.badRequest('MOVEMENT_BEFORE_OPENING', { openingDate: isoDate(account.openingDate) });
  }
  return account;
}

export async function usableCategory(id: number, kind: string) {
  const category = await tenantDb().financeCategory.findUnique({ where: { id } });
  if (!category) throw AppError.badRequest('CATEGORY_INVALID');
  if (category.kind !== kind) throw AppError.badRequest('CATEGORY_KIND_MISMATCH');
  if (!category.isActive) throw AppError.conflict('CATEGORY_INACTIVE');
}

async function assertContributor(viewer: Viewer, personId: number | null | undefined) {
  if (!personId) return;
  if (!seesContributors(viewer)) throw AppError.forbidden('CONTRIBUTIONS_FORBIDDEN');
  if (!(await tenantDb().person.count({ where: { id: personId, deletedAt: null } }))) {
    throw AppError.badRequest('PERSON_INVALID');
  }
}

export async function assertDate(date: string) {
  if (date > (await accountToday())) throw AppError.badRequest('DATE_IN_FUTURE');
}

/**
 * Solo se editan o anulan uno por uno los movimientos confirmados cargados a mano: los pendientes se
 * confirman o rechazan, y los de un arqueo se anulan con el arqueo entero.
 */
function assertOwnMovement(m: { status: string; offeringCountId: number | null }) {
  if (m.status === 'voided' || m.status === 'rejected') throw AppError.conflict('MOVEMENT_VOIDED');
  if (m.status === 'pending') throw AppError.conflict('MOVEMENT_PENDING');
  if (m.offeringCountId) throw AppError.conflict('MOVEMENT_FROM_COUNT', { countId: m.offeringCountId });
}

export async function createMovement(viewer: Viewer, input: z.infer<typeof CreateMovementSchema>) {
  await assertDate(input.date);
  await assertPeriodOpen(input.date);
  await usableAccount(input.financeAccountId, input.date);
  await usableCategory(input.categoryId, input.kind);
  await assertContributor(viewer, input.personId);
  const created = await tenantDb().financeMovement.create({
    data: {
      accountId: currentAccountId(),
      financeAccountId: input.financeAccountId,
      categoryId: input.categoryId,
      kind: input.kind,
      date: toDate(input.date),
      amount: toMoney(input.amount),
      description: input.description ?? null,
      personId: input.personId ?? null,
      isAnonymous: input.personId ? false : (input.isAnonymous ?? false),
      paymentMethod: input.paymentMethod ?? null,
      reference: input.reference ?? null,
      createdById: viewer.userId,
    },
    select: { id: true },
  });
  await audit({
    action: 'finance.movement.create',
    entity: 'FinanceMovement',
    entityId: created.id,
    after: {
      kind: input.kind,
      amount: input.amount,
      date: input.date,
      financeAccountId: input.financeAccountId,
    },
  });
  return getMovement(viewer, created.id);
}

export async function updateMovement(
  viewer: Viewer,
  id: number,
  input: z.infer<typeof UpdateMovementSchema>,
) {
  const db = tenantDb();
  const before = await db.financeMovement.findUnique({ where: { id } });
  if (!before) throw AppError.notFound('MOVEMENT_NOT_FOUND');
  assertOwnMovement(before);
  // Una transferencia son dos movimientos enlazados: se anula y se vuelve a cargar.
  if (before.transferPairId) throw AppError.conflict('TRANSFER_EDIT_FORBIDDEN');
  const date = input.date ?? isoDate(before.date)!;
  if (input.date) await assertDate(input.date);
  await assertPeriodOpen(isoDate(before.date), input.date);
  const currentAccount = before.financeAccountId!; // confirmado: siempre tiene caja
  const targetAccount = input.financeAccountId ?? currentAccount;
  if (input.financeAccountId || input.date) {
    const account = await usableAccount(targetAccount, date);
    const current = await db.financeAccount.findUniqueOrThrow({ where: { id: currentAccount } });
    if (account.currency !== current.currency) throw AppError.conflict('FINANCE_CURRENCY_MISMATCH');
  }
  if (input.categoryId) await usableCategory(input.categoryId, before.kind);
  if (input.personId !== undefined) await assertContributor(viewer, input.personId);
  if (
    input.personId === undefined &&
    input.isAnonymous !== undefined &&
    before.personId &&
    !seesContributors(viewer)
  ) {
    throw AppError.forbidden('CONTRIBUTIONS_FORBIDDEN');
  }
  const { date: newDate, amount: newAmount, ...rest } = input;
  await db.financeMovement.update({
    where: { id },
    data: {
      ...rest,
      ...(newDate ? { date: toDate(newDate) } : {}),
      ...(newAmount !== undefined ? { amount: toMoney(newAmount) } : {}),
      ...(input.personId ? { isAnonymous: false } : {}),
    },
  });
  await audit({
    action: 'finance.movement.update',
    entity: 'FinanceMovement',
    entityId: id,
    before: { amount: present(before.amount), date: isoDate(before.date), categoryId: before.categoryId },
    after: { changed: Object.keys(input) },
  });
  return getMovement(viewer, id);
}

export async function voidMovement(viewer: Viewer, id: number, reason: string) {
  const db = tenantDb();
  const movement = await db.financeMovement.findUnique({ where: { id } });
  if (!movement) throw AppError.notFound('MOVEMENT_NOT_FOUND');
  assertOwnMovement(movement);
  await assertPeriodOpen(isoDate(movement.date));
  // Anular una transferencia anula las dos patas.
  const ids = movement.transferPairId ? [id, movement.transferPairId] : [id];
  await db.financeMovement.updateMany({
    where: { id: { in: ids } },
    data: { status: 'voided', voidedAt: new Date(), voidedById: viewer.userId, voidReason: reason },
  });
  await audit({
    action: 'finance.movement.void',
    entity: 'FinanceMovement',
    entityId: id,
    before: { status: movement.status, amount: present(movement.amount) },
    after: { reason, ids },
  });
  return getMovement(viewer, id);
}

export async function createTransfer(viewer: Viewer, input: z.infer<typeof TransferSchema>) {
  if (input.fromAccountId === input.toAccountId) throw AppError.badRequest('TRANSFER_SAME_ACCOUNT');
  await assertDate(input.date);
  await assertPeriodOpen(input.date);
  const from = await usableAccount(input.fromAccountId, input.date);
  const to = await usableAccount(input.toAccountId, input.date);
  if (from.currency !== to.currency) throw AppError.badRequest('TRANSFER_CURRENCY_MISMATCH');
  const accountId = currentAccountId();
  const base = {
    accountId,
    date: toDate(input.date),
    amount: toMoney(input.amount),
    description: input.description ?? null,
    reference: input.reference ?? null,
    createdById: viewer.userId,
  };
  const db = tenantDb();
  const [outId, inId] = await db.$transaction(async (tx) => {
    const out = await tx.financeMovement.create({
      data: { ...base, financeAccountId: from.id, kind: 'transfer_out' },
      select: { id: true },
    });
    const inbound = await tx.financeMovement.create({
      data: { ...base, financeAccountId: to.id, kind: 'transfer_in', transferPairId: out.id },
      select: { id: true },
    });
    await tx.financeMovement.update({ where: { id: out.id }, data: { transferPairId: inbound.id } });
    return [out.id, inbound.id];
  });
  await audit({
    action: 'finance.transfer.create',
    entity: 'FinanceMovement',
    entityId: outId,
    after: { from: from.id, to: to.id, amount: input.amount, date: input.date, pair: inId },
  });
  return { out: await getMovement(viewer, outId), in: await getMovement(viewer, inId) };
}

// ───────────── Resumen ─────────────

/** Saldos de todas las cajas, ingresos y egresos del mes (por moneda) y los últimos movimientos. */
export async function summary(viewer: Viewer) {
  const today = await accountToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const db = tenantDb();
  const [accounts, month, recent, pending, drafts] = await Promise.all([
    listAccounts(false),
    totalsByCurrency({ status: 'confirmed', date: { gte: toDate(monthStart), lte: toDate(today) } }),
    db.financeMovement.findMany({
      where: { status: 'confirmed' },
      select: movementSelect,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: 8,
    }),
    db.financeMovement.count({ where: { status: 'pending' } }),
    db.offeringCount.count({ where: { status: 'draft' } }),
  ]);
  return {
    today,
    month: { from: monthStart, to: today, totals: month },
    /** Ofrendas de célula por confirmar y arqueos en borrador (avisos del tablero). */
    pending: { movements: pending, counts: drafts },
    /** Último día cerrado: antes de esa fecha no se carga ni se modifica nada. */
    closedUntil: await lastClosedDay(),
    accounts,
    recent: recent.map((r) => presentMovement(r, viewer)),
  };
}
