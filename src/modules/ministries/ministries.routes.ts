import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as ministries from './ministries.service.js';

const t = tenantRouter();
export const ministriesRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const MemberParam = IdParam.extend({ memberId: z.coerce.number().int().positive() });
const RoleParam = IdParam.extend({ roleId: z.coerce.number().int().positive() });

t.get('/ministries', 'ministerios.ver', async (req, res) => {
  res.json(await ministries.listMinistries(await viewerOf(req), parse(ministries.ListQuery, req.query)));
});

t.get('/ministries/:id', 'ministerios.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await ministries.getMinistry(await viewerOf(req), id));
});

/** Crear y borrar necesita gestionar todos (lo valida el servicio). */
t.post('/ministries', 'ministerios.gestionar', async (req, res) => {
  const input = parse(ministries.CreateMinistrySchema, req.body);
  res.status(201).json(await ministries.createMinistry(await viewerOf(req), input));
});

t.patch('/ministries/:id', 'ministerios.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(ministries.UpdateMinistrySchema, req.body);
  res.json(await ministries.updateMinistry(await viewerOf(req), id, input));
});

t.delete('/ministries/:id', 'ministerios.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await ministries.deleteMinistry(await viewerOf(req), id);
  res.status(204).end();
});

// ───────────── Integrantes ─────────────

t.post('/ministries/:id/members', 'ministerios.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(ministries.MemberSchema, req.body);
  res.status(201).json(await ministries.addMember(await viewerOf(req), id, input));
});

t.patch('/ministries/:id/members/:memberId', 'ministerios.gestionar', async (req, res) => {
  const { id, memberId } = parse(MemberParam, req.params);
  const input = parse(ministries.MemberRoleSchema, req.body);
  res.json(await ministries.updateMember(await viewerOf(req), id, memberId, input));
});

t.delete('/ministries/:id/members/:memberId', 'ministerios.gestionar', async (req, res) => {
  const { id, memberId } = parse(MemberParam, req.params);
  res.json(await ministries.removeMember(await viewerOf(req), id, memberId));
});

// ───────────── Puestos ─────────────

t.post('/ministries/:id/service-roles', 'ministerios.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(ministries.RoleSchema, req.body);
  res.status(201).json(await ministries.createRole(await viewerOf(req), id, input));
});

// Antes de /service-roles/:roleId.
t.put('/ministries/:id/service-roles/order', 'ministerios.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { ids } = parse(ministries.ReorderSchema, req.body);
  res.json(await ministries.reorderRoles(await viewerOf(req), id, ids));
});

t.patch('/ministries/:id/service-roles/:roleId', 'ministerios.gestionar', async (req, res) => {
  const { id, roleId } = parse(RoleParam, req.params);
  const input = parse(ministries.UpdateRoleSchema, req.body);
  res.json(await ministries.updateRole(await viewerOf(req), id, roleId, input));
});

t.delete('/ministries/:id/service-roles/:roleId', 'ministerios.gestionar', async (req, res) => {
  const { id, roleId } = parse(RoleParam, req.params);
  res.json(await ministries.deleteRole(await viewerOf(req), id, roleId));
});
