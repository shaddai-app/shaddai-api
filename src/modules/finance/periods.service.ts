import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { addDays, toDate } from '../../core/time/local-date.js';
import { isoDate } from '../people/people.service.js';
import type { Viewer } from '../people/people.scope.js';
import { accountToday, balances } from './finance.service.js';
import { present, ZERO, type Money } from './money.js';

// ═════════════ Cierre mensual ═════════════
//
// Los meses se cierran en orden (desde el de la primera apertura de caja) y solo cuando ya
// terminaron. Así los meses cerrados son siempre un tramo continuo desde el principio, y solo se
// reabre el último (reabrir uno del medio dejaría inconsistentes los saldos de los siguientes).

export const PeriodParams = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

type YearMonth = { year: number; month: number };

const pad = (n: number) => String(n).padStart(2, '0');
/** Solo año y mes (el objeto se usa como filtro de Prisma). */
const only = ({ year, month }: YearMonth): YearMonth => ({ year, month });
const firstDay = ({ year, month }: YearMonth) => `${year}-${pad(month)}-01`;
const lastDay = ({ year, month }: YearMonth) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
const key = ({ year, month }: YearMonth) => year * 12 + (month - 1);
const fromKey = (k: number): YearMonth => ({ year: Math.floor(k / 12), month: (k % 12) + 1 });

/** Mes de la primera apertura de caja (antes de eso no hay nada que cerrar). */
async function firstMonth(): Promise<YearMonth | null> {
  const first = await tenantDb().financeAccount.aggregate({ _min: { openingDate: true } });
  const date = isoDate(first._min.openingDate);
  return date ? { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) } : null;
}

const userSelect = { id: true, firstName: true, lastName: true } as const;

async function periodRows() {
  const rows = await tenantDb().financePeriod.findMany({
    select: {
      year: true,
      month: true,
      status: true,
      closedAt: true,
      closedById: true,
      notes: true,
      reopenedAt: true,
      reopenedById: true,
      reopenReason: true,
    },
  });
  return new Map(rows.map((r) => [key(r), r]));
}

async function usersById(ids: (number | null | undefined)[]) {
  const unique = [...new Set(ids.filter((v): v is number => typeof v === 'number'))];
  const users = unique.length
    ? await tenantDb().user.findMany({ where: { id: { in: unique } }, select: userSelect })
    : [];
  return (id: number | null | undefined) => users.find((u) => u.id === id) ?? null;
}

/**
 * Estado de cada mes, del más nuevo al más viejo: cerrado o abierto, y si se puede cerrar (terminó y
 * los anteriores están cerrados) o reabrir (es el último cerrado).
 */
export async function listPeriods() {
  const today = await accountToday();
  const start = await firstMonth();
  if (!start) return { items: [], lastClosed: null };
  const current = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const stored = await periodRows();
  const who = await usersById([...stored.values()].flatMap((r) => [r.closedById, r.reopenedById]));
  const closedKeys = [...stored.values()].filter((r) => r.status === 'closed').map(key);
  const lastClosedKey = closedKeys.length ? Math.max(...closedKeys) : null;
  const firstOpenKey = (() => {
    for (let k = key(start); k <= key(current); k++) if (stored.get(k)?.status !== 'closed') return k;
    return null;
  })();

  const items = [];
  for (let k = key(current); k >= key(start); k--) {
    const ym = fromKey(k);
    const row = stored.get(k);
    const closed = row?.status === 'closed';
    items.push({
      ...ym,
      from: firstDay(ym),
      to: lastDay(ym),
      status: closed ? ('closed' as const) : ('open' as const),
      closedAt: closed ? row.closedAt : null,
      closedBy: closed ? who(row.closedById) : null,
      notes: closed ? row.notes : null,
      reopenedAt: row?.reopenedAt ?? null,
      reopenedBy: who(row?.reopenedById),
      reopenReason: row?.reopenReason ?? null,
      canClose: !closed && k === firstOpenKey && lastDay(ym) < today,
      canReopen: closed && k === lastClosedKey,
    });
  }
  return { items, lastClosed: lastClosedKey === null ? null : fromKey(lastClosedKey) };
}

/** Saldos del mes por caja: apertura, ingresos, egresos, transferencias y cierre (en vivo). */
async function computeBalances(ym: YearMonth) {
  const from = firstDay(ym);
  const to = lastDay(ym);
  const db = tenantDb();
  const accounts = await db.financeAccount.findMany({
    where: { openingDate: { lte: toDate(to) } },
    select: { id: true, name: true, currency: true, isActive: true },
    orderBy: { name: 'asc' },
  });
  const ids = accounts.map((a) => a.id);
  const opening = await balances(ids, addDays(from, -1));
  const sums = await db.financeMovement.groupBy({
    by: ['financeAccountId', 'kind'],
    where: {
      status: 'confirmed',
      financeAccountId: { in: ids },
      date: { gte: toDate(from), lte: toDate(to) },
    },
    _sum: { amount: true },
  });
  const sumOf = (id: number, kind: string) =>
    sums.find((s) => s.financeAccountId === id && s.kind === kind)?._sum.amount ?? ZERO;
  return accounts.map((a) => {
    const open = opening.get(a.id) ?? ZERO;
    const row = {
      income: sumOf(a.id, 'income'),
      expense: sumOf(a.id, 'expense'),
      transfersIn: sumOf(a.id, 'transfer_in'),
      transfersOut: sumOf(a.id, 'transfer_out'),
    };
    const closing = open.plus(row.income).minus(row.expense).plus(row.transfersIn).minus(row.transfersOut);
    return { financeAccount: a, opening: open, ...row, closing };
  });
}

type BalanceRow = Awaited<ReturnType<typeof computeBalances>>[number];

const presentBalance = (
  b: Omit<BalanceRow, 'financeAccount'> & { financeAccount: BalanceRow['financeAccount'] },
) => ({
  financeAccount: b.financeAccount,
  opening: present(b.opening),
  income: present(b.income),
  expense: present(b.expense),
  transfersIn: present(b.transfersIn),
  transfersOut: present(b.transfersOut),
  closing: present(b.closing),
});

/** Totales por moneda (las cajas no se convierten). */
function totalsByCurrency(
  rows: {
    financeAccount: { currency: string };
    opening: Money;
    income: Money;
    expense: Money;
    closing: Money;
  }[],
) {
  const map = new Map<string, { opening: Money; income: Money; expense: Money; closing: Money }>();
  for (const r of rows) {
    const t = map.get(r.financeAccount.currency) ?? {
      opening: ZERO,
      income: ZERO,
      expense: ZERO,
      closing: ZERO,
    };
    map.set(r.financeAccount.currency, {
      opening: t.opening.plus(r.opening),
      income: t.income.plus(r.income),
      expense: t.expense.plus(r.expense),
      closing: t.closing.plus(r.closing),
    });
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      opening: present(t.opening),
      income: present(t.income),
      expense: present(t.expense),
      closing: present(t.closing),
    }));
}

async function findListed(ym: YearMonth) {
  const list = await listPeriods();
  const item = list.items.find((i) => i.year === ym.year && i.month === ym.month);
  if (!item) throw AppError.notFound('PERIOD_NOT_FOUND');
  return item;
}

/**
 * Detalle del mes: saldos por caja (la foto guardada si está cerrado; en vivo si está abierto) y lo
 * que quedó sin resolver con fecha en el mes (ofrendas pendientes y arqueos en borrador).
 */
export async function getPeriod(input: YearMonth) {
  const ym = only(input);
  const item = await findListed(ym);
  const db = tenantDb();
  const range = { gte: toDate(item.from), lte: toDate(item.to) };
  let rows: (BalanceRow & { financeAccount: BalanceRow['financeAccount'] })[];
  if (item.status === 'closed') {
    const period = await db.financePeriod.findFirstOrThrow({ where: ym, select: { id: true } });
    const saved = await db.financePeriodBalance.findMany({
      where: { periodId: period.id },
      select: {
        opening: true,
        income: true,
        expense: true,
        transfersIn: true,
        transfersOut: true,
        closing: true,
        financeAccount: { select: { id: true, name: true, currency: true, isActive: true } },
      },
      orderBy: { financeAccount: { name: 'asc' } },
    });
    rows = saved;
  } else {
    rows = await computeBalances(ym);
  }
  const [pending, drafts] = await Promise.all([
    db.financeMovement.count({ where: { status: 'pending', date: range } }),
    db.offeringCount.count({ where: { status: 'draft', date: range } }),
  ]);
  return {
    ...item,
    balances: rows.map(presentBalance),
    totals: totalsByCurrency(rows),
    unresolved: { pending, drafts },
  };
}

export async function closePeriod(viewer: Viewer, input: YearMonth, notes: string | null) {
  const ym = only(input);
  const item = await findListed(ym);
  if (item.status === 'closed') throw AppError.conflict('PERIOD_ALREADY_CLOSED');
  if (item.to >= (await accountToday())) throw AppError.conflict('PERIOD_NOT_ENDED');
  if (!item.canClose) {
    const list = await listPeriods();
    const previous = list.items.filter((i) => i.status === 'open' && i.from < item.from).at(-1);
    throw AppError.conflict(
      'PERIOD_PREVIOUS_OPEN',
      previous ? { year: previous.year, month: previous.month } : {},
    );
  }
  const rows = await computeBalances(ym);
  const data = rows.map((r) => ({
    financeAccountId: r.financeAccount.id,
    opening: r.opening,
    income: r.income,
    expense: r.expense,
    transfersIn: r.transfersIn,
    transfersOut: r.transfersOut,
    closing: r.closing,
  }));
  const db = tenantDb();
  const closed = { status: 'closed', closedAt: new Date(), closedById: viewer.userId, notes };
  const existing = await db.financePeriod.findFirst({ where: ym, select: { id: true } });
  // Escritura anidada: los saldos son hijos del período (ver CHILD_MODELS).
  let periodId = existing?.id;
  if (existing) {
    await db.financePeriod.update({
      where: { id: existing.id },
      data: { ...closed, balances: { deleteMany: {}, create: data } },
    });
  } else {
    const created = await db.financePeriod.create({
      data: { accountId: currentAccountId(), ...ym, ...closed, balances: { create: data } },
      select: { id: true },
    });
    periodId = created.id;
  }
  await audit({
    action: 'finance.period.close',
    entity: 'FinancePeriod',
    entityId: periodId,
    after: { ...ym, notes, totals: totalsByCurrency(rows) },
  });
  return getPeriod(ym);
}

export async function reopenPeriod(viewer: Viewer, input: YearMonth, reason: string) {
  const ym = only(input);
  const item = await findListed(ym);
  if (item.status !== 'closed') throw AppError.conflict('PERIOD_NOT_CLOSED');
  if (!item.canReopen) throw AppError.conflict('PERIOD_LATER_CLOSED');
  const db = tenantDb();
  const period = await db.financePeriod.findFirstOrThrow({ where: ym, select: { id: true } });
  await db.financePeriod.update({
    where: { id: period.id },
    data: {
      status: 'open',
      closedAt: null,
      closedById: null,
      reopenedAt: new Date(),
      reopenedById: viewer.userId,
      reopenReason: reason,
      balances: { deleteMany: {} },
    },
  });
  await audit({
    action: 'finance.period.reopen',
    entity: 'FinancePeriod',
    entityId: period.id,
    before: { ...ym, closedAt: item.closedAt, closedBy: item.closedBy?.id ?? null },
    after: { reason },
  });
  return getPeriod(ym);
}
