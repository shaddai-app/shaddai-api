import { getContext } from '../context.js';
import { AppError } from '../http/errors.js';
import { prisma } from './prisma.js';

/**
 * Aislamiento multi-tenant a nivel de Prisma.
 *
 * - TENANT_MODELS (tienen accountId): toda lectura/escritura se filtra por la cuenta actual y los create
 *   reciben el accountId forzado; no se puede mover una fila a otra cuenta.
 * - CHILD_MODELS (sin accountId, cuelgan de un modelo tenant): se filtran por la relación con su padre
 *   y en los create se verifica que los padres referenciados sean de la cuenta.
 * - Account: la cuenta actual solo se ve a sí misma; no puede crear ni borrar cuentas.
 * - Cualquier otro modelo es global (Plan, Permission) o de sistema (AuditLog) y pasa sin filtro.
 *
 * Un modelo nuevo con accountId DEBE agregarse acá (lo verifica test/unit/tenant-models.test.ts).
 */
export const TENANT_MODELS = new Set([
  'User',
  'Role',
  'Campus',
  'CatalogItem',
  'Tag',
  'FileObject',
  'Household',
  'Person',
  'PersonStatusHistory',
  'PersonMilestone',
  'PersonPosition',
  'NewcomerSubmission',
  'ImportJob',
  'Network',
  'Zone',
  'Cell',
  'CellMember',
  'CellReport',
  'CellMultiplication',
  'ConsolidationStep',
  'ConsolidationCase',
  'FollowUp',
  'FinanceAccount',
  'FinanceCategory',
  'FinanceMovement',
  'OfferingCount',
  'FinancePeriod',
  'CalendarEvent',
]);

/** relación -> { fk, modelo padre } */
export const CHILD_MODELS: Record<string, Record<string, { fk: string; parent: string }>> = {
  UserRole: { user: { fk: 'userId', parent: 'User' }, role: { fk: 'roleId', parent: 'Role' } },
  RolePermission: { role: { fk: 'roleId', parent: 'Role' } },
  RefreshToken: { user: { fk: 'userId', parent: 'User' } },
  PasswordResetToken: { user: { fk: 'userId', parent: 'User' } },
  PersonTag: { person: { fk: 'personId', parent: 'Person' }, tag: { fk: 'tagId', parent: 'Tag' } },
  ConsolidationCaseStep: {
    case: { fk: 'caseId', parent: 'ConsolidationCase' },
    step: { fk: 'stepId', parent: 'ConsolidationStep' },
  },
  MovementAttachment: {
    movement: { fk: 'movementId', parent: 'FinanceMovement' },
    file: { fk: 'fileId', parent: 'FileObject' },
  },
  OfferingCountLine: {
    count: { fk: 'countId', parent: 'OfferingCount' },
    category: { fk: 'categoryId', parent: 'FinanceCategory' },
  },
  FinancePeriodBalance: {
    period: { fk: 'periodId', parent: 'FinancePeriod' },
    financeAccount: { fk: 'financeAccountId', parent: 'FinanceAccount' },
  },
  EventException: { event: { fk: 'eventId', parent: 'CalendarEvent' } },
  CellReportAttendance: {
    report: { fk: 'reportId', parent: 'CellReport' },
    person: { fk: 'personId', parent: 'Person' },
  },
};

/** Modelos con accountId que NO se filtran por tenant (a propósito). */
export const TENANT_EXEMPT_MODELS = new Set(['AuditLog']);

type Args = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown };
type Where = Record<string, unknown>;

const WHERE_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** Agrega un filtro con AND sin pisar los campos únicos de un findUnique/update. */
function andWhere(where: Where | undefined, filter: Where): Where {
  const existing = where?.AND;
  const and = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return { ...where, AND: [...and, filter] };
}

function stripAccountId(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const { accountId: _ignored, account: _ignoredRelation, ...rest } = data as Record<string, unknown>;
  return rest;
}

function withAccountId(data: unknown, accountId: number): unknown {
  if (Array.isArray(data)) return data.map((d) => withAccountId(d, accountId));
  if ('account' in (data as object)) {
    // Mezclar la relación con el accountId implícito es un error de programación.
    throw new Error('Tenant: no uses `account: { connect }` en modelos tenant; el accountId es implícito.');
  }
  return { ...(data as object), accountId };
}

function scopeTenantModel(operation: string, args: Args, accountId: number): Args {
  const next: Args = { ...args };
  if (WHERE_OPS.has(operation)) next.where = andWhere(args.where, { accountId });
  if (CREATE_OPS.has(operation)) next.data = withAccountId(args.data, accountId);
  if (operation.startsWith('update')) next.data = stripAccountId(args.data);
  if (operation === 'upsert') {
    next.create = withAccountId(args.create, accountId);
    next.update = stripAccountId(args.update);
  }
  return next;
}

function scopeAccountModel(operation: string, args: Args, accountId: number): Args {
  if (CREATE_OPS.has(operation) || operation.startsWith('delete') || operation === 'upsert') {
    throw AppError.forbidden('TENANT_ACCOUNT_WRITE_FORBIDDEN');
  }
  return { ...args, where: andWhere(args.where, { id: accountId }) };
}

async function assertParentsOwned(model: string, data: unknown, accountId: number): Promise<void> {
  const relations = CHILD_MODELS[model]!;
  const rows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  for (const { fk, parent } of Object.values(relations)) {
    const ids = [...new Set(rows.map((r) => r[fk]).filter((v) => v !== undefined))] as number[];
    if (ids.length === 0) continue;
    const delegate = (prisma as unknown as Record<string, { count: (a: object) => Promise<number> }>)[
      parent.charAt(0).toLowerCase() + parent.slice(1)
    ]!;
    const owned = await delegate.count({ where: { id: { in: ids }, accountId } });
    if (owned !== ids.length) throw AppError.notFound();
  }
}

async function scopeChildModel(
  model: string,
  operation: string,
  args: Args,
  accountId: number,
): Promise<Args> {
  const relations = CHILD_MODELS[model]!;
  const next: Args = { ...args };
  if (WHERE_OPS.has(operation)) {
    let where = args.where;
    for (const relation of Object.keys(relations)) where = andWhere(where, { [relation]: { accountId } });
    next.where = where;
  }
  if (CREATE_OPS.has(operation)) await assertParentsOwned(model, args.data, accountId);
  if (operation === 'upsert') await assertParentsOwned(model, args.create, accountId);
  if (operation.startsWith('update')) await assertParentsOwned(model, args.data, accountId);
  return next;
}

function buildTenantClient(accountId: number) {
  return prisma.$extends({
    name: 'tenant',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const a = (args ?? {}) as Args;
          if (TENANT_MODELS.has(model)) return query(scopeTenantModel(operation, a, accountId));
          if (model === 'Account') return query(scopeAccountModel(operation, a, accountId));
          if (model in CHILD_MODELS) return query(await scopeChildModel(model, operation, a, accountId));
          return query(a);
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof buildTenantClient>;

const cache = new Map<number, TenantClient>();
const CACHE_MAX = 500;

/** Cliente Prisma limitado a una cuenta. */
export function tenantClientFor(accountId: number): TenantClient {
  let client = cache.get(accountId);
  if (!client) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    client = buildTenantClient(accountId);
    cache.set(accountId, client);
  }
  return client;
}

/** Cuenta de la request actual (la fija authenticate). */
export function currentAccountId(): number {
  const accountId = getContext()?.accountId;
  if (typeof accountId !== 'number') throw AppError.forbidden('ACCOUNT_USER_REQUIRED');
  return accountId;
}

/**
 * Cliente de la cuenta de la request actual. Único acceso a datos en módulos de negocio.
 * En los create, los tipos de Prisma piden accountId: pasá `accountId: currentAccountId()`
 * (el filtro igual lo fuerza, así que nunca se puede escribir en otra cuenta).
 */
export function tenantDb(): TenantClient {
  return tenantClientFor(currentAccountId());
}
