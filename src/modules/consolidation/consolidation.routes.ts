import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { getPermissions } from '../../core/rbac/permission-cache.js';
import { viewerOf } from '../people/people.scope.js';
import * as consolidation from './consolidation.service.js';

const t = tenantRouter();
export const consolidationRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const StepParam = IdParam.extend({ stepId: z.coerce.number().int().positive() });

// ───────────── Pasos (configuración) ─────────────

const StepInput = z
  .object({
    name: z.string().trim().min(1).max(100).nullable(),
    dueDays: z.number().int().min(0).max(365),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

t.get('/consolidation/steps', ['consolidacion.ver', 'catalogos.gestionar'], async (req, res) => {
  const { includeInactive } = parse(z.object({ includeInactive: z.stringbool().default(false) }), req.query);
  res.json({ items: await consolidation.listSteps(includeInactive) });
});

t.post('/consolidation/steps', 'catalogos.gestionar', async (req, res) => {
  const input = parse(StepInput.required({ name: true }), req.body);
  if (!input.name) throw AppError.badRequest('CATALOG_NAME_REQUIRED');
  await consolidation.ensureDefaultSteps();
  const db = tenantDb();
  const last = await db.consolidationStep.aggregate({ _max: { sortOrder: true } });
  const step = await db.consolidationStep.create({
    data: {
      accountId: currentAccountId(),
      name: input.name,
      dueDays: input.dueDays ?? 7,
      sortOrder: (last._max.sortOrder ?? 0) + 10,
    },
    select: consolidation.stepSelect,
  });
  await audit({
    action: 'consolidation.step.create',
    entity: 'ConsolidationStep',
    entityId: step.id,
    after: step,
  });
  res.status(201).json(step);
});

t.put('/consolidation/steps/order', 'catalogos.gestionar', async (req, res) => {
  const { ids } = parse(
    z.object({ ids: z.array(z.number().int().positive()).min(1).max(50) }).strict(),
    req.body,
  );
  const db = tenantDb();
  const unique = [...new Set(ids)];
  if ((await db.consolidationStep.count({ where: { id: { in: unique } } })) !== unique.length) {
    throw AppError.badRequest('CATALOG_ITEM_INVALID');
  }
  await db.$transaction(
    unique.map((id, i) => db.consolidationStep.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } })),
  );
  res.json({ items: await consolidation.listSteps(true) });
});

t.patch('/consolidation/steps/:id', 'catalogos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(StepInput, req.body);
  const db = tenantDb();
  const before = await db.consolidationStep.findUnique({ where: { id }, select: consolidation.stepSelect });
  if (!before) throw AppError.notFound('CATALOG_ITEM_NOT_FOUND');
  if (input.name === null && !before.systemKey) throw AppError.badRequest('CATALOG_NAME_REQUIRED');
  if (input.isActive === false && before.isActive) {
    const others = await db.consolidationStep.count({ where: { isActive: true, id: { not: id } } });
    if (others === 0) throw AppError.conflict('CONSOLIDATION_LAST_STEP');
  }
  const step = await db.consolidationStep.update({
    where: { id },
    data: input,
    select: consolidation.stepSelect,
  });
  await audit({
    action: 'consolidation.step.update',
    entity: 'ConsolidationStep',
    entityId: id,
    before,
    after: step,
  });
  res.json(step);
});

t.delete('/consolidation/steps/:id', 'catalogos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const db = tenantDb();
  const step = await db.consolidationStep.findUnique({ where: { id } });
  if (!step) throw AppError.notFound('CATALOG_ITEM_NOT_FOUND');
  if (step.systemKey) throw AppError.conflict('CATALOG_SYSTEM_ITEM');
  if (await db.consolidationCaseStep.count({ where: { stepId: id } }))
    throw AppError.conflict('CATALOG_IN_USE');
  await db.consolidationStep.delete({ where: { id } });
  await audit({
    action: 'consolidation.step.delete',
    entity: 'ConsolidationStep',
    entityId: id,
    before: step,
  });
  res.status(204).end();
});

// ───────────── Casos ─────────────

t.get('/consolidation/board', 'consolidacion.ver', async (req, res) => {
  const query = parse(
    z.object({
      consolidatorUserId: z.coerce.number().int().positive().optional(),
      mine: z.stringbool().optional(),
      unassigned: z.stringbool().optional(),
    }),
    req.query,
  );
  res.json(await consolidation.board(await viewerOf(req), query));
});

/** Usuarios a los que se les puede asignar un caso (activos y con acceso a consolidación). */
t.get('/consolidation/consolidators', 'consolidacion.asignar', async (_req, res) => {
  const users = await tenantDb().user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
  const items = [];
  for (const u of users) {
    const p = await getPermissions(u.id);
    if (p['consolidacion.ver'] || p['consolidacion.gestionar']) items.push(u);
  }
  res.json({ items });
});

t.get('/consolidation/cases', 'consolidacion.ver', async (req, res) => {
  res.json(
    await consolidation.listCases(await viewerOf(req), parse(consolidation.ListCasesQuery, req.query)),
  );
});

t.post('/consolidation/cases', 'consolidacion.gestionar', async (req, res) => {
  const input = parse(
    z
      .object({
        personId: z.number().int().positive(),
        consolidatorUserId: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    req.body,
  );
  res.status(201).json(await consolidation.createCase(await viewerOf(req), input));
});

t.get('/consolidation/cases/:id', 'consolidacion.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await consolidation.getCase(await viewerOf(req), id));
});

t.patch('/consolidation/cases/:id/assign', 'consolidacion.asignar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { consolidatorUserId } = parse(
    z.object({ consolidatorUserId: z.number().int().positive().nullable() }).strict(),
    req.body,
  );
  res.json(await consolidation.assignCase(await viewerOf(req), id, consolidatorUserId));
});

t.patch('/consolidation/cases/:id', 'consolidacion.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(
    z
      .object({
        status: z.enum(['open', 'completed', 'dropped']),
        closeReason: z.string().trim().max(300).nullable().optional(),
      })
      .strict(),
    req.body,
  );
  res.json(await consolidation.setStatus(await viewerOf(req), id, input));
});

t.post('/consolidation/cases/:id/move', 'consolidacion.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { stepId } = parse(z.object({ stepId: z.number().int().positive() }).strict(), req.body);
  res.json(await consolidation.moveToStep(await viewerOf(req), id, stepId));
});

t.post('/consolidation/cases/:id/steps/:stepId/complete', 'consolidacion.gestionar', async (req, res) => {
  const { id, stepId } = parse(StepParam, req.params);
  const { notes } = parse(
    z.object({ notes: z.string().trim().max(1000).nullable().optional() }).strict(),
    req.body ?? {},
  );
  res.json(await consolidation.completeStep(await viewerOf(req), id, stepId, notes ?? null));
});

t.post('/consolidation/cases/:id/steps/:stepId/undo', 'consolidacion.gestionar', async (req, res) => {
  const { id, stepId } = parse(StepParam, req.params);
  res.json(await consolidation.undoStep(await viewerOf(req), id, stepId));
});

// ───────────── Seguimientos ─────────────

t.get('/people/:id/follow-ups', 'consolidacion.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await consolidation.followUps(await viewerOf(req), id));
});

t.post('/people/:id/follow-ups', 'consolidacion.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(consolidation.FollowUpSchema, req.body);
  res.status(201).json(await consolidation.addFollowUp(await viewerOf(req), id, input));
});

t.delete('/follow-ups/:id', ['consolidacion.ver', 'consolidacion.gestionar'], async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await consolidation.deleteFollowUp(await viewerOf(req), id);
  res.status(204).end();
});

t.get('/me/consolidation/tasks', ['consolidacion.ver', 'consolidacion.gestionar'], async (req, res) => {
  res.json(await consolidation.myTasks(await viewerOf(req)));
});
