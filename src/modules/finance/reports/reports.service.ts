import { z } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import { currentAccountId, tenantDb } from '../../../core/db/tenant.js';
import { AppError } from '../../../core/http/errors.js';
import { toDate } from '../../../core/time/local-date.js';
import { isoDate } from '../../people/people.service.js';
import { scopeOf, type Viewer } from '../../people/people.scope.js';
import { accountToday, balances, seesContributors } from '../finance.service.js';
import { present, ZERO, type Money } from '../money.js';
import { REPORT_LOCALES } from './labels.js';

// Datos de los reportes (lo que después se presenta como JSON, PDF o Excel). Solo cuentan los
// movimientos confirmados; los montos se suman en Decimal y nunca se mezclan monedas.

const isoDateStr = z.iso.date();

export const ReportFormat = z.enum(['json', 'pdf', 'xlsx']).default('json');
export const ReportLang = z.enum(REPORT_LOCALES).optional();

export const IncomeStatementQuery = z.object({
  from: isoDateStr.optional(),
  to: isoDateStr.optional(),
  financeAccountId: z.coerce.number().int().positive().optional(),
});
export const BalancesQuery = z.object({ asOf: isoDateStr.optional() });
export const TrendQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
export const ContributionsQuery = TrendQuery;

/** Datos de la iglesia para los encabezados, la moneda y el idioma por defecto. */
export async function churchInfo() {
  const account = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: {
      name: true,
      legalName: true,
      taxId: true,
      address: true,
      currency: true,
      defaultLocale: true,
    },
  });
  return { ...account, today: await accountToday() };
}

const sumBy = <K extends string>(rows: { key: K; value: Money }[]) => {
  const map = new Map<K, Money>();
  for (const r of rows) map.set(r.key, (map.get(r.key) ?? ZERO).plus(r.value));
  return map;
};

const categorySelect = { id: true, kind: true, systemKey: true, name: true, sortOrder: true } as const;

// ───────────── Estado de resultados ─────────────

/** Ingresos y egresos del período por categoría, separados por moneda. */
export async function incomeStatement(q: z.infer<typeof IncomeStatementQuery>) {
  const today = await accountToday();
  const from = q.from ?? `${today.slice(0, 4)}-01-01`;
  const to = q.to ?? today;
  if (from > to) throw AppError.badRequest('DATE_RANGE_INVALID');
  const db = tenantDb();
  const where: Prisma.FinanceMovementWhereInput = {
    status: 'confirmed',
    kind: { in: ['income', 'expense'] },
    date: { gte: toDate(from), lte: toDate(to) },
    ...(q.financeAccountId ? { financeAccountId: q.financeAccountId } : {}),
  };
  const [sums, accounts, categories] = await Promise.all([
    db.financeMovement.groupBy({
      by: ['financeAccountId', 'categoryId', 'kind'],
      where,
      _sum: { amount: true },
    }),
    db.financeAccount.findMany({ select: { id: true, name: true, currency: true } }),
    db.financeCategory.findMany({ select: categorySelect }),
  ]);
  const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
  const categoryOf = new Map(categories.map((c) => [c.id, c]));
  const byCurrency = new Map<string, Map<number, { kind: string; amount: Money }>>();
  for (const s of sums) {
    const currency = currencyOf.get(s.financeAccountId!)!;
    const rows = byCurrency.get(currency) ?? new Map();
    const current = rows.get(s.categoryId!) ?? { kind: s.kind, amount: ZERO };
    current.amount = current.amount.plus(s._sum.amount ?? ZERO);
    rows.set(s.categoryId!, current);
    byCurrency.set(currency, rows);
  }
  const currencies = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, rows]) => {
      const lines = [...rows.entries()]
        .map(([categoryId, r]) => ({ category: categoryOf.get(categoryId)!, kind: r.kind, amount: r.amount }))
        .sort((a, b) => a.category.sortOrder - b.category.sortOrder || a.category.id - b.category.id);
      const pick = (kind: string) => lines.filter((l) => l.kind === kind);
      const total = (kind: string) => pick(kind).reduce((sum, l) => sum.plus(l.amount), ZERO);
      const present2 = (kind: string) =>
        pick(kind).map(({ category: { sortOrder: _s, ...category }, amount }) => ({
          category,
          amount: present(amount)!,
        }));
      return {
        currency,
        income: present2('income'),
        expense: present2('expense'),
        totalIncome: present(total('income'))!,
        totalExpense: present(total('expense'))!,
        net: present(total('income').minus(total('expense')))!,
      };
    });
  const account = q.financeAccountId ? accounts.find((a) => a.id === q.financeAccountId) : undefined;
  if (q.financeAccountId && !account) throw AppError.badRequest('FINANCE_ACCOUNT_INVALID');
  return { from, to, financeAccount: account ?? null, currencies };
}

// ───────────── Saldos ─────────────

export async function balancesReport(q: z.infer<typeof BalancesQuery>) {
  const asOf = q.asOf ?? (await accountToday());
  const accounts = await tenantDb().financeAccount.findMany({
    where: { openingDate: { lte: toDate(asOf) } },
    select: { id: true, name: true, type: true, currency: true, isActive: true },
    orderBy: [{ currency: 'asc' }, { name: 'asc' }],
  });
  const bal = await balances(
    accounts.map((a) => a.id),
    asOf,
  );
  const items = accounts.map((a) => ({ ...a, balance: present(bal.get(a.id) ?? ZERO)! }));
  const totals = sumBy(items.map((i) => ({ key: i.currency, value: bal.get(i.id) ?? ZERO })));
  return {
    asOf,
    items,
    totals: [...totals.entries()].map(([currency, value]) => ({ currency, balance: present(value)! })),
  };
}

// ───────────── Evolución mensual ─────────────

/** Diezmos, ofrendas, otros ingresos y egresos de cada mes del año, por moneda. */
export async function monthlyTrend(q: z.infer<typeof TrendQuery>) {
  const today = await accountToday();
  const year = q.year ?? Number(today.slice(0, 4));
  const db = tenantDb();
  const rows = await db.financeMovement.findMany({
    where: {
      status: 'confirmed',
      kind: { in: ['income', 'expense'] },
      date: { gte: toDate(`${year}-01-01`), lte: toDate(`${year}-12-31`) },
    },
    select: {
      kind: true,
      date: true,
      amount: true,
      financeAccount: { select: { currency: true } },
      category: { select: { systemKey: true } },
    },
  });
  type Bucket = 'tithe' | 'offering' | 'otherIncome' | 'expense';
  const bucketOf = (r: (typeof rows)[number]): Bucket =>
    r.kind === 'expense'
      ? 'expense'
      : r.category?.systemKey === 'tithe'
        ? 'tithe'
        : r.category?.systemKey === 'offering' || r.category?.systemKey === 'special_offering'
          ? 'offering'
          : 'otherIncome';
  const data = new Map<string, Map<number, Record<Bucket, Money>>>();
  for (const r of rows) {
    const currency = r.financeAccount!.currency;
    const month = Number(isoDate(r.date)!.slice(5, 7));
    const months = data.get(currency) ?? new Map();
    const bucket = months.get(month) ?? { tithe: ZERO, offering: ZERO, otherIncome: ZERO, expense: ZERO };
    const b = bucketOf(r);
    bucket[b] = bucket[b].plus(r.amount);
    months.set(month, bucket);
    data.set(currency, months);
  }
  // Desde el primer mes con datos hasta el actual (si es el año en curso) o diciembre.
  const lastMonth = year === Number(today.slice(0, 4)) ? Number(today.slice(5, 7)) : 12;
  const used = [...data.values()].flatMap((m) => [...m.keys()]);
  const firstMonth = used.length ? Math.min(...used) : lastMonth + 1;
  return {
    year,
    currencies: [...data.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, months]) => {
        const list = Array.from({ length: lastMonth - firstMonth + 1 }, (_, i) => {
          const b = months.get(firstMonth + i) ?? {
            tithe: ZERO,
            offering: ZERO,
            otherIncome: ZERO,
            expense: ZERO,
          };
          const income = b.tithe.plus(b.offering).plus(b.otherIncome);
          return {
            month: firstMonth + i,
            tithe: present(b.tithe)!,
            offering: present(b.offering)!,
            otherIncome: present(b.otherIncome)!,
            expense: present(b.expense)!,
            net: present(income.minus(b.expense))!,
          };
        });
        const sum = (k: 'tithe' | 'offering' | 'otherIncome' | 'expense' | 'net') =>
          Math.round(list.reduce((s, m) => s + m[k] * 100, 0)) / 100;
        return {
          currency,
          months: list,
          totals: {
            tithe: sum('tithe'),
            offering: sum('offering'),
            otherIncome: sum('otherIncome'),
            expense: sum('expense'),
            net: sum('net'),
          },
        };
      }),
  };
}

// ───────────── Aportes nominales ─────────────

export function assertContributions(viewer: Viewer) {
  if (!seesContributors(viewer)) throw AppError.forbidden('CONTRIBUTIONS_FORBIDDEN');
}

/** El documento es un dato sensible: solo va si el usuario puede verlo. */
const seesDocuments = (viewer: Viewer) => Boolean(scopeOf(viewer, 'personas.ver_sensibles'));

/** Aportes con nombre del año, por persona y moneda (diezmos aparte del resto). */
export async function contributions(viewer: Viewer, q: z.infer<typeof ContributionsQuery>) {
  assertContributions(viewer);
  const today = await accountToday();
  const year = q.year ?? Number(today.slice(0, 4));
  const rows = await tenantDb().financeMovement.findMany({
    where: {
      status: 'confirmed',
      kind: 'income',
      personId: { not: null },
      date: { gte: toDate(`${year}-01-01`), lte: toDate(`${year}-12-31`) },
    },
    select: {
      amount: true,
      personId: true,
      financeAccount: { select: { currency: true } },
      category: { select: { systemKey: true } },
      person: {
        select: { id: true, firstName: true, lastName: true, documentNumber: true, deletedAt: true },
      },
    },
  });
  const docs = seesDocuments(viewer);
  const people = new Map<
    number,
    {
      person: { id: number; firstName: string; lastName: string; documentNumber?: string | null };
      byCurrency: Map<string, { tithe: Money; other: Money; count: number }>;
    }
  >();
  for (const r of rows) {
    const p = r.person!;
    const entry = people.get(p.id) ?? {
      person: {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        ...(docs ? { documentNumber: p.documentNumber } : {}),
      },
      byCurrency: new Map(),
    };
    const currency = r.financeAccount!.currency;
    const t = entry.byCurrency.get(currency) ?? { tithe: ZERO, other: ZERO, count: 0 };
    if (r.category?.systemKey === 'tithe') t.tithe = t.tithe.plus(r.amount);
    else t.other = t.other.plus(r.amount);
    t.count++;
    entry.byCurrency.set(currency, t);
    people.set(p.id, entry);
  }
  const items = [...people.values()]
    .sort(
      (a, b) =>
        a.person.lastName.localeCompare(b.person.lastName) ||
        a.person.firstName.localeCompare(b.person.firstName),
    )
    .map((e) => ({
      person: e.person,
      byCurrency: [...e.byCurrency.entries()].map(([currency, t]) => ({
        currency,
        tithe: present(t.tithe)!,
        other: present(t.other)!,
        total: present(t.tithe.plus(t.other))!,
        count: t.count,
      })),
    }));
  const totals = new Map<string, Money>();
  for (const r of rows) {
    const c = r.financeAccount!.currency;
    totals.set(c, (totals.get(c) ?? ZERO).plus(r.amount));
  }
  return {
    year,
    items,
    totals: [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, v]) => ({ currency, total: present(v)! })),
  };
}

/** Aportes de una persona en un año (pestaña "Aportes" de la ficha y constancia anual). */
export async function personContributions(viewer: Viewer, personId: number, yearInput?: number) {
  assertContributions(viewer);
  const db = tenantDb();
  const person = await db.person.findFirst({
    where: { id: personId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, documentNumber: true },
  });
  if (!person) throw AppError.notFound('PERSON_NOT_FOUND');
  const today = await accountToday();
  const year = yearInput ?? Number(today.slice(0, 4));
  const base = { personId, status: 'confirmed', kind: 'income' } as const;
  const [movements, first] = await Promise.all([
    db.financeMovement.findMany({
      where: { ...base, date: { gte: toDate(`${year}-01-01`), lte: toDate(`${year}-12-31`) } },
      select: {
        id: true,
        date: true,
        amount: true,
        paymentMethod: true,
        description: true,
        financeAccount: { select: { id: true, name: true, currency: true } },
        category: { select: { id: true, kind: true, systemKey: true, name: true } },
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    db.financeMovement.aggregate({ where: base, _min: { date: true } }),
  ]);
  const totals = sumBy(movements.map((m) => ({ key: m.financeAccount!.currency, value: m.amount })));
  const firstYear = first._min.date ? Number(isoDate(first._min.date)!.slice(0, 4)) : year;
  const { documentNumber, ...rest } = person;
  return {
    person: { ...rest, ...(seesDocuments(viewer) ? { documentNumber } : {}) },
    year,
    /** Años con aportes (para elegir de cuál sacar la constancia). */
    years: yearsBetween(Math.min(firstYear, year), Math.max(Number(today.slice(0, 4)), year)),
    movements: movements.map((m) => ({ ...m, date: isoDate(m.date)!, amount: present(m.amount)! })),
    totals: [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, v]) => ({ currency, total: present(v)! })),
  };
}

// ───────────── Recibo ─────────────

/** Movimiento de ingreso confirmado para el recibo (el aportante solo con permiso). */
export async function receiptData(viewer: Viewer, id: number) {
  const m = await tenantDb().financeMovement.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      status: true,
      date: true,
      amount: true,
      description: true,
      paymentMethod: true,
      reference: true,
      isAnonymous: true,
      financeAccount: { select: { name: true, currency: true } },
      category: { select: { systemKey: true, name: true } },
      person: { select: { firstName: true, lastName: true, documentNumber: true } },
    },
  });
  if (!m) throw AppError.notFound('MOVEMENT_NOT_FOUND');
  if (m.kind !== 'income' || m.status !== 'confirmed') throw AppError.conflict('RECEIPT_NOT_AVAILABLE');
  const sees = seesContributors(viewer);
  return {
    ...m,
    // Con nombre pero sin permiso de verlo: el recibo deja el renglón en blanco (no dice "anónimo").
    nominal: m.person !== null,
    date: isoDate(m.date)!,
    amount: present(m.amount)!,
    person:
      sees && m.person
        ? {
            firstName: m.person.firstName,
            lastName: m.person.lastName,
            documentNumber: seesDocuments(viewer) ? m.person.documentNumber : null,
          }
        : null,
  };
}

/** Años de "to" a "from", del más nuevo al más viejo. */
const yearsBetween = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => to - i);
