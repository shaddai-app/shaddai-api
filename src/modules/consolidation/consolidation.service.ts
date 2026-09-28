import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import type { PermissionKey } from '../../core/rbac/catalog.js';
import { getPermissions } from '../../core/rbac/permission-cache.js';
import { addDays, toDate, todayIn } from '../../core/time/local-date.js';
import { catalogRef, fold, isoDate } from '../people/people.service.js';
import { canOnPerson, ownCaseWhere, scopeOf, type Viewer } from '../people/people.scope.js';

/** Pasos con los que arranca cada iglesia (renombrables; name null = traducido por systemKey). */
export const DEFAULT_STEPS: [systemKey: string, dueDays: number][] = [
  ['first_contact', 2],
  ['home_visit', 7],
  ['cell_invite', 14],
  ['encounter', 30],
  ['discipleship', 60],
];

export const FOLLOW_UP_TYPES = ['call', 'visit', 'whatsapp', 'message', 'prayer', 'other'] as const;
export type CaseSource = 'manual' | 'form' | 'cell';

type Db = ReturnType<typeof tenantDb> | Prisma.TransactionClient;

async function accountToday() {
  const { timezone } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { timezone: true },
  });
  return todayIn(timezone);
}

// ───────────── Pasos ─────────────

/** Cuentas creadas antes de consolidación reciben los pasos por defecto la primera vez. */
export async function ensureDefaultSteps(db: Db = tenantDb()) {
  if ((await db.consolidationStep.count()) > 0) return;
  await db.consolidationStep.createMany({
    data: DEFAULT_STEPS.map(([systemKey, dueDays], i) => ({
      accountId: currentAccountId(),
      systemKey,
      dueDays,
      sortOrder: (i + 1) * 10,
    })),
  });
}

export const stepSelect = {
  id: true,
  systemKey: true,
  name: true,
  sortOrder: true,
  dueDays: true,
  isActive: true,
} as const;

export async function listSteps(includeInactive = false) {
  await ensureDefaultSteps();
  return tenantDb().consolidationStep.findMany({
    where: includeInactive ? {} : { isActive: true },
    select: stepSelect,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
}

// ───────────── Alcance ─────────────

export function caseWhereFor(viewer: Viewer, key: PermissionKey): Prisma.ConsolidationCaseWhereInput | null {
  const scope = scopeOf(viewer, key);
  if (!scope) return null;
  return scope === 'all' ? {} : ownCaseWhere(viewer);
}

async function caseInScope(viewer: Viewer, key: PermissionKey, id: number) {
  const where = caseWhereFor(viewer, key);
  if (!where) return false;
  return (await tenantDb().consolidationCase.count({ where: { AND: [{ id }, where] } })) > 0;
}

async function visibleCase(viewer: Viewer, id: number) {
  if (!(await caseInScope(viewer, 'consolidacion.ver', id))) throw AppError.notFound('CASE_NOT_FOUND');
}

async function manageableCase(viewer: Viewer, id: number) {
  await visibleCase(viewer, id);
  if (!(await caseInScope(viewer, 'consolidacion.gestionar', id)))
    throw AppError.forbidden('CASE_MANAGE_FORBIDDEN');
}

// ───────────── Presentación ─────────────

const cardSelect = {
  id: true,
  status: true,
  source: true,
  openedAt: true,
  closedAt: true,
  closeReason: true,
  currentStepId: true,
  person: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      photoFileId: true,
      phone: true,
      status: { select: catalogRef },
    },
  },
  consolidator: { select: { id: true, firstName: true, lastName: true } },
  steps: { select: { stepId: true, dueAt: true, completedAt: true } },
  followUps: { select: { date: true, nextActionAt: true }, orderBy: { date: 'desc' }, take: 1 },
} as const;

type CardRow = Prisma.ConsolidationCaseGetPayload<{ select: typeof cardSelect }>;

function presentCard(row: CardRow, today: string) {
  const { steps, followUps, openedAt, closedAt, ...rest } = row;
  const current = steps.find((s) => s.stepId === row.currentStepId);
  const dueAt = current ? isoDate(current.dueAt) : null;
  const done = steps.filter((s) => s.completedAt).length;
  return {
    ...rest,
    openedAt: isoDate(openedAt),
    closedAt: isoDate(closedAt),
    currentStepDueAt: dueAt,
    overdue: row.status === 'open' && dueAt !== null && dueAt < today,
    progress: { done, total: steps.length },
    lastFollowUpAt: isoDate(followUps[0]?.date),
    nextActionAt: isoDate(followUps[0]?.nextActionAt),
  };
}

// ───────────── Apertura y recálculo ─────────────

/** El paso actual es el primer paso activo sin completar; si no queda ninguno, el caso se completa. */
async function recompute(db: ReturnType<typeof tenantDb>, caseId: number, today: string) {
  const steps = await db.consolidationCaseStep.findMany({
    where: { caseId },
    include: { step: { select: { sortOrder: true, isActive: true } } },
  });
  const pending = steps
    .filter((s) => !s.completedAt && s.step.isActive)
    .sort((a, b) => a.step.sortOrder - b.step.sortOrder);
  const next = pending[0];
  const current = await db.consolidationCase.findUniqueOrThrow({
    where: { id: caseId },
    select: { status: true },
  });
  await db.consolidationCase.update({
    where: { id: caseId },
    data: next
      ? {
          currentStepId: next.stepId,
          ...(current.status === 'completed' ? { status: 'open', closedAt: null } : {}),
        }
      : {
          currentStepId: null,
          ...(current.status === 'open' ? { status: 'completed', closedAt: toDate(today) } : {}),
        },
  });
}

/**
 * Abre un caso para una persona (si ya tiene uno abierto lo devuelve, sin duplicar). Lo usan el alta
 * manual, el formulario «Soy nuevo» y las visitas nuevas de los reportes de célula.
 */
export async function openCase(input: {
  personId: number;
  consolidatorUserId?: number | null;
  source: CaseSource;
  createdById: number | null;
}): Promise<{ id: number; created: boolean }> {
  const db = tenantDb();
  const existing = await db.consolidationCase.findFirst({
    where: { personId: input.personId, status: 'open' },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  await ensureDefaultSteps();
  const today = await accountToday();
  const steps = await db.consolidationStep.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const created = await db.consolidationCase.create({
    data: {
      accountId: currentAccountId(),
      personId: input.personId,
      consolidatorUserId: input.consolidatorUserId ?? null,
      source: input.source,
      openedAt: toDate(today),
      currentStepId: steps[0]?.id ?? null,
      createdById: input.createdById,
      // Escritura anidada (tabla hija): el chequeo de padres no vería el caso recién creado.
      steps: { create: steps.map((s) => ({ stepId: s.id, dueAt: toDate(addDays(today, s.dueDays)) })) },
    },
    select: { id: true },
  });
  await audit({
    action: 'consolidation.case.open',
    entity: 'ConsolidationCase',
    entityId: created.id,
    after: {
      personId: input.personId,
      source: input.source,
      consolidatorUserId: input.consolidatorUserId ?? null,
    },
  });
  return { id: created.id, created: true };
}

/** El consolidador tiene que ser un usuario activo de la cuenta con acceso a consolidación. */
async function assertConsolidator(userId: number) {
  const user = await tenantDb().user.findFirst({ where: { id: userId, isActive: true, deletedAt: null } });
  if (!user) throw AppError.badRequest('CONSOLIDATOR_INVALID');
  const perms = await getPermissions(userId);
  if (!perms['consolidacion.ver'] && !perms['consolidacion.gestionar']) {
    throw AppError.badRequest('CONSOLIDATOR_NO_ACCESS');
  }
}

// ───────────── Casos ─────────────

export const ListCasesQuery = PaginationQuery.extend({
  status: z.enum(['open', 'completed', 'dropped']).default('open'),
  q: z.string().trim().max(100).optional(),
  consolidatorUserId: z.coerce.number().int().positive().optional(),
  unassigned: z.stringbool().optional(),
  mine: z.stringbool().optional(),
  overdue: z.stringbool().optional(),
  personId: z.coerce.number().int().positive().optional(),
});

function casesWhere(viewer: Viewer, query: Partial<z.infer<typeof ListCasesQuery>>) {
  const scope = caseWhereFor(viewer, 'consolidacion.ver');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');
  const and: Prisma.ConsolidationCaseWhereInput[] = [scope, { person: { deletedAt: null } }];
  if (query.status) and.push({ status: query.status });
  if (query.consolidatorUserId) and.push({ consolidatorUserId: query.consolidatorUserId });
  if (query.unassigned) and.push({ consolidatorUserId: null });
  if (query.mine) and.push({ consolidatorUserId: viewer.userId });
  if (query.personId) and.push({ personId: query.personId });
  for (const token of (query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5)) {
    and.push({ person: { searchText: { contains: fold(token) } } });
  }
  return and;
}

export async function listCases(viewer: Viewer, query: z.infer<typeof ListCasesQuery>) {
  const today = await accountToday();
  const and = casesWhere(viewer, query);
  if (query.overdue) {
    and.push({ status: 'open', steps: { some: { completedAt: null, dueAt: { lt: toDate(today) } } } });
  }
  const where = { AND: and };
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.consolidationCase.findMany({
      where,
      select: cardSelect,
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      ...toSkipTake(query),
    }),
    db.consolidationCase.count({ where }),
  ]);
  return paged(
    rows.map((r) => presentCard(r, today)),
    total,
    query,
  );
}

/** Tablero kanban: una columna por paso activo con los casos abiertos que están en ese paso. */
export async function board(
  viewer: Viewer,
  query: { consolidatorUserId?: number; mine?: boolean; unassigned?: boolean },
) {
  const [steps, today] = await Promise.all([listSteps(), accountToday()]);
  const rows = await tenantDb().consolidationCase.findMany({
    where: { AND: casesWhere(viewer, { ...query, status: 'open' }) },
    select: cardSelect,
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  const cards = rows.map((r) => presentCard(r, today));
  return {
    columns: steps.map((s) => ({ step: s, cases: cards.filter((c) => c.currentStepId === s.id) })),
    // Casos cuyo paso actual se desactivó (o sin pasos): se muestran aparte para no perderlos.
    unplaced: cards.filter((c) => !steps.some((s) => s.id === c.currentStepId)),
    summary: {
      open: cards.length,
      overdue: cards.filter((c) => c.overdue).length,
      unassigned: cards.filter((c) => !c.consolidator).length,
    },
  };
}

export async function getCase(viewer: Viewer, id: number) {
  await visibleCase(viewer, id);
  const today = await accountToday();
  const db = tenantDb();
  const row = await db.consolidationCase.findUniqueOrThrow({ where: { id }, select: cardSelect });
  const [steps, followUps, manage, assign] = await Promise.all([
    db.consolidationCaseStep.findMany({
      where: { caseId: id },
      select: {
        id: true,
        dueAt: true,
        completedAt: true,
        completedById: true,
        notes: true,
        step: { select: stepSelect },
      },
    }),
    listFollowUpsFor(row.person.id),
    caseInScope(viewer, 'consolidacion.gestionar', id),
    caseInScope(viewer, 'consolidacion.asignar', id),
  ]);
  return {
    ...presentCard(row, today),
    steps: steps
      .sort((a, b) => a.step.sortOrder - b.step.sortOrder)
      .map((s) => ({
        ...s,
        dueAt: isoDate(s.dueAt),
        completedAt: isoDate(s.completedAt),
        overdue: !s.completedAt && isoDate(s.dueAt)! < today,
      })),
    followUps,
    access: { manage, assign },
  };
}

export async function createCase(
  viewer: Viewer,
  input: { personId: number; consolidatorUserId?: number | null },
) {
  if (!(await canOnPerson(viewer, 'personas.ver', input.personId)))
    throw AppError.badRequest('PERSON_INVALID');
  const existing = await tenantDb().consolidationCase.findFirst({
    where: { personId: input.personId, status: 'open' },
    select: { id: true },
  });
  if (existing) throw AppError.conflict('CASE_ALREADY_OPEN', { caseId: existing.id });
  if (input.consolidatorUserId) {
    if (!scopeOf(viewer, 'consolidacion.asignar')) throw AppError.forbidden('CASE_ASSIGN_FORBIDDEN');
    await assertConsolidator(input.consolidatorUserId);
  }
  const { id } = await openCase({ ...input, source: 'manual', createdById: viewer.userId });
  return getCase(viewer, id);
}

export async function assignCase(viewer: Viewer, id: number, consolidatorUserId: number | null) {
  await visibleCase(viewer, id);
  if (!(await caseInScope(viewer, 'consolidacion.asignar', id)))
    throw AppError.forbidden('CASE_ASSIGN_FORBIDDEN');
  if (consolidatorUserId) await assertConsolidator(consolidatorUserId);
  const db = tenantDb();
  const before = await db.consolidationCase.findUniqueOrThrow({
    where: { id },
    select: { consolidatorUserId: true },
  });
  await db.consolidationCase.update({ where: { id }, data: { consolidatorUserId } });
  await audit({
    action: 'consolidation.case.assign',
    entity: 'ConsolidationCase',
    entityId: id,
    before,
    after: { consolidatorUserId },
  });
  return getCase(viewer, id);
}

async function caseStep(caseId: number, stepId: number) {
  const s = await tenantDb().consolidationCaseStep.findFirst({ where: { caseId, stepId } });
  if (!s) throw AppError.notFound('CASE_STEP_NOT_FOUND');
  return s;
}

async function assertOpenOrCompleted(id: number) {
  const c = await tenantDb().consolidationCase.findUniqueOrThrow({ where: { id }, select: { status: true } });
  if (c.status === 'dropped') throw AppError.conflict('CASE_DROPPED');
}

export async function completeStep(viewer: Viewer, id: number, stepId: number, notes: string | null) {
  await manageableCase(viewer, id);
  await assertOpenOrCompleted(id);
  const s = await caseStep(id, stepId);
  const today = await accountToday();
  const db = tenantDb();
  await db.consolidationCaseStep.update({
    where: { id: s.id },
    data: {
      completedAt: s.completedAt ?? toDate(today),
      completedById: viewer.userId,
      notes: notes ?? s.notes,
    },
  });
  await recompute(db, id, today);
  await audit({
    action: 'consolidation.step.complete',
    entity: 'ConsolidationCase',
    entityId: id,
    after: { stepId },
  });
  return getCase(viewer, id);
}

export async function undoStep(viewer: Viewer, id: number, stepId: number) {
  await manageableCase(viewer, id);
  await assertOpenOrCompleted(id);
  const s = await caseStep(id, stepId);
  const db = tenantDb();
  await db.consolidationCaseStep.update({
    where: { id: s.id },
    data: { completedAt: null, completedById: null },
  });
  await recompute(db, id, await accountToday());
  await audit({
    action: 'consolidation.step.undo',
    entity: 'ConsolidationCase',
    entityId: id,
    after: { stepId },
  });
  return getCase(viewer, id);
}

/**
 * Mover la tarjeta a una columna del tablero: los pasos anteriores quedan completos y ese paso y los
 * siguientes, pendientes.
 */
export async function moveToStep(viewer: Viewer, id: number, stepId: number) {
  await manageableCase(viewer, id);
  await assertOpenOrCompleted(id);
  await caseStep(id, stepId);
  const today = await accountToday();
  const db = tenantDb();
  const steps = await db.consolidationCaseStep.findMany({
    where: { caseId: id },
    include: { step: { select: { sortOrder: true } } },
  });
  const target = steps.find((s) => s.stepId === stepId)!;
  await db.$transaction(
    steps.map((s) =>
      db.consolidationCaseStep.update({
        where: { id: s.id },
        data:
          s.step.sortOrder < target.step.sortOrder
            ? { completedAt: s.completedAt ?? toDate(today), completedById: s.completedById ?? viewer.userId }
            : { completedAt: null, completedById: null },
      }),
    ),
  );
  await recompute(db, id, today);
  await audit({
    action: 'consolidation.case.move',
    entity: 'ConsolidationCase',
    entityId: id,
    after: { stepId },
  });
  return getCase(viewer, id);
}

export async function setStatus(
  viewer: Viewer,
  id: number,
  input: { status: 'open' | 'completed' | 'dropped'; closeReason?: string | null },
) {
  await manageableCase(viewer, id);
  if (input.status === 'dropped' && !input.closeReason) throw AppError.badRequest('CLOSE_REASON_REQUIRED');
  const db = tenantDb();
  const today = await accountToday();
  const c = await db.consolidationCase.findUniqueOrThrow({ where: { id } });
  if (input.status === 'open' && c.status !== 'open') {
    const other = await db.consolidationCase.count({
      where: { personId: c.personId, status: 'open', id: { not: id } },
    });
    if (other) throw AppError.conflict('CASE_ALREADY_OPEN');
  }
  await db.consolidationCase.update({
    where: { id },
    data: {
      status: input.status,
      closeReason: input.status === 'open' ? null : (input.closeReason ?? null),
      closedAt: input.status === 'open' ? null : toDate(today),
    },
  });
  if (input.status === 'open') await recompute(db, id, today);
  await audit({
    action: 'consolidation.case.status',
    entity: 'ConsolidationCase',
    entityId: id,
    before: { status: c.status },
    after: input,
  });
  return getCase(viewer, id);
}

// ───────────── Seguimientos ─────────────

export const FollowUpSchema = z
  .object({
    type: z.enum(FOLLOW_UP_TYPES),
    date: z.iso.date().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    nextAction: z.string().trim().max(200).nullable().optional(),
    nextActionAt: z.iso.date().nullable().optional(),
  })
  .strict();

const followUpSelect = {
  id: true,
  caseId: true,
  type: true,
  date: true,
  notes: true,
  nextAction: true,
  nextActionAt: true,
  createdById: true,
  createdAt: true,
} as const;

async function listFollowUpsFor(personId: number) {
  const db = tenantDb();
  const rows = await db.followUp.findMany({
    where: { personId },
    select: followUpSelect,
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map(({ date, nextActionAt, createdById, ...f }) => ({
    ...f,
    date: isoDate(date),
    nextActionAt: isoDate(nextActionAt),
    createdBy: byId.get(createdById) ?? null,
  }));
}

/** Ver seguimientos: quien ve a la persona o tiene un caso de ella en su alcance. */
async function assertFollowUpAccess(
  viewer: Viewer,
  personId: number,
  key: 'consolidacion.ver' | 'consolidacion.gestionar',
) {
  const where = caseWhereFor(viewer, key);
  const viaCase = where
    ? (await tenantDb().consolidationCase.count({ where: { AND: [{ personId }, where] } })) > 0
    : false;
  const viaPerson = Boolean(scopeOf(viewer, key)) && (await canOnPerson(viewer, 'personas.ver', personId));
  if (!viaCase && !viaPerson) throw AppError.notFound('PERSON_NOT_FOUND');
}

export async function followUps(viewer: Viewer, personId: number) {
  await assertFollowUpAccess(viewer, personId, 'consolidacion.ver');
  return { items: await listFollowUpsFor(personId) };
}

export async function addFollowUp(viewer: Viewer, personId: number, input: z.infer<typeof FollowUpSchema>) {
  await assertFollowUpAccess(viewer, personId, 'consolidacion.gestionar');
  const today = await accountToday();
  const date = input.date ?? today;
  if (date > today) throw AppError.badRequest('DATE_IN_FUTURE');
  if (input.nextActionAt && input.nextActionAt < date) throw AppError.badRequest('DATE_RANGE_INVALID');
  const db = tenantDb();
  const open = await db.consolidationCase.findFirst({
    where: { personId, status: 'open' },
    select: { id: true },
  });
  const f = await db.followUp.create({
    data: {
      accountId: currentAccountId(),
      personId,
      caseId: open?.id ?? null,
      type: input.type,
      date: toDate(date),
      notes: input.notes ?? null,
      nextAction: input.nextAction ?? null,
      nextActionAt: input.nextActionAt ? toDate(input.nextActionAt) : null,
      createdById: viewer.userId,
    },
    select: { id: true },
  });
  await audit({
    action: 'consolidation.followup.add',
    entity: 'Person',
    entityId: personId,
    after: { id: f.id, type: input.type },
  });
  return { items: await listFollowUpsFor(personId) };
}

export async function deleteFollowUp(viewer: Viewer, id: number) {
  const db = tenantDb();
  const f = await db.followUp.findUnique({ where: { id } });
  if (!f) throw AppError.notFound('FOLLOW_UP_NOT_FOUND');
  await assertFollowUpAccess(viewer, f.personId, 'consolidacion.ver');
  // Cada uno borra los suyos; con gestión total se puede borrar cualquiera.
  if (f.createdById !== viewer.userId && scopeOf(viewer, 'consolidacion.gestionar') !== 'all') {
    throw AppError.forbidden('FOLLOW_UP_DELETE_FORBIDDEN');
  }
  await db.followUp.delete({ where: { id } });
  await audit({
    action: 'consolidation.followup.delete',
    entity: 'Person',
    entityId: f.personId,
    before: { id },
  });
}

/**
 * «Mis tareas»: próximas acciones vencidas o de hoy (del último seguimiento que cargué para cada
 * persona) y mis casos asignados con el paso actual vencido.
 */
export async function myTasks(viewer: Viewer) {
  const today = await accountToday();
  const db = tenantDb();
  const mine = await db.followUp.findMany({
    where: { createdById: viewer.userId, person: { deletedAt: null } },
    select: {
      ...followUpSelect,
      personId: true,
      person: { select: { id: true, firstName: true, lastName: true, phone: true, photoFileId: true } },
    },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: 1000,
  });
  const latest = new Map<number, (typeof mine)[number]>();
  for (const f of mine) if (!latest.has(f.personId)) latest.set(f.personId, f);
  const actions = [...latest.values()]
    .filter((f) => f.nextActionAt && isoDate(f.nextActionAt)! <= today)
    .map((f) => ({
      followUpId: f.id,
      person: f.person,
      nextAction: f.nextAction,
      nextActionAt: isoDate(f.nextActionAt),
      overdue: isoDate(f.nextActionAt)! < today,
    }))
    .sort((a, b) => a.nextActionAt!.localeCompare(b.nextActionAt!));

  const cases = await db.consolidationCase.findMany({
    where: {
      consolidatorUserId: viewer.userId,
      status: 'open',
      person: { deletedAt: null },
      steps: { some: { completedAt: null, dueAt: { lt: toDate(today) } } },
    },
    select: cardSelect,
    orderBy: { openedAt: 'asc' },
  });
  return { actions, overdueCases: cases.map((c) => presentCard(c, today)).filter((c) => c.overdue) };
}
