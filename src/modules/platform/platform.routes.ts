import { platformRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { authOf } from '../../core/middleware/authenticate.js';
import { startImpersonation } from './impersonation.service.js';
import {
  AccountUserParams,
  AuditQuery,
  ChangeStatusSchema,
  CreateAccountSchema,
  IdParam,
  ImpersonateSchema,
  ListAccountsQuery,
  PlanSchema,
  ResetAdminSchema,
  UpdateAccountSchema,
} from './platform.schemas.js';
import * as platform from './platform.service.js';

const p = platformRouter();
export const platformRoutes = p.router;

// Cuentas (iglesias)
p.get('/platform/accounts', async (req, res) => {
  res.json(await platform.listAccounts(parse(ListAccountsQuery, req.query)));
});

p.post('/platform/accounts', async (req, res) => {
  // Incluye temporaryPassword: el front la muestra una sola vez para copiarla.
  res.status(201).json(await platform.createAccount(parse(CreateAccountSchema, req.body)));
});

p.get('/platform/accounts/:id', async (req, res) => {
  res.json(await platform.getAccount(parse(IdParam, req.params).id));
});

p.patch('/platform/accounts/:id', async (req, res) => {
  res.json(await platform.updateAccount(parse(IdParam, req.params).id, parse(UpdateAccountSchema, req.body)));
});

p.post('/platform/accounts/:id/status', async (req, res) => {
  res.json(
    await platform.changeAccountStatus(parse(IdParam, req.params).id, parse(ChangeStatusSchema, req.body)),
  );
});

p.get('/platform/accounts/:id/admins', async (req, res) => {
  res.json({ items: await platform.listAccountAdmins(parse(IdParam, req.params).id) });
});

p.post('/platform/accounts/:id/admins/:userId/reset-password', async (req, res) => {
  const { id, userId } = parse(AccountUserParams, req.params);
  const { sendAccessEmail } = parse(ResetAdminSchema, req.body ?? {});
  res.json(await platform.resetAdminPassword(id, userId, sendAccessEmail));
});

// Planes
p.get('/platform/plans', async (_req, res) => {
  res.json({ items: await platform.listPlans() });
});

p.post('/platform/plans', async (req, res) => {
  res.status(201).json(await platform.createPlan(parse(PlanSchema, req.body)));
});

p.patch('/platform/plans/:id', async (req, res) => {
  res.json(await platform.updatePlan(parse(IdParam, req.params).id, parse(PlanSchema.partial(), req.body)));
});

// Panorama y auditoría
p.get('/platform/stats', async (_req, res) => {
  res.json(await platform.platformStats());
});

p.get('/platform/audit', async (req, res) => {
  res.json(await platform.listAudit(parse(AuditQuery, req.query)));
});

// Soporte: "entrar como" un usuario de una cuenta (30 min, auditado, banner en el front).
p.post('/platform/impersonate', async (req, res) => {
  const { userId, reason } = parse(ImpersonateSchema, req.body);
  res.json(await startImpersonation(authOf(req).userId, userId, reason));
});
