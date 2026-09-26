import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { CreateRoleSchema, IdParam, MatrixSchema, UpdateRoleSchema } from './roles.schemas.js';
import * as roles from './roles.service.js';

const t = tenantRouter();
export const rolesRouter = t.router;

t.get('/permissions', 'roles.ver', async (_req, res) => {
  res.json({ modules: roles.permissionCatalog() });
});

// Selector de roles al crear/editar usuarios: también lo necesita quien gestiona usuarios.
t.get('/roles', ['roles.ver', 'usuarios.gestionar'], async (_req, res) => {
  res.json({ items: await roles.listRoles() });
});

// Antes de /roles/:id para que "matrix" no se tome como id.
t.get('/roles/matrix', 'roles.ver', async (_req, res) => {
  res.json(await roles.getMatrix());
});

t.put('/roles/matrix', 'roles.gestionar', async (req, res) => {
  res.json(await roles.saveMatrix(parse(MatrixSchema, req.body)));
});

t.get('/roles/:id', 'roles.ver', async (req, res) => {
  res.json(await roles.getRole(parse(IdParam, req.params).id));
});

t.post('/roles', 'roles.gestionar', async (req, res) => {
  res.status(201).json(await roles.createRole(parse(CreateRoleSchema, req.body)));
});

t.patch('/roles/:id', 'roles.gestionar', async (req, res) => {
  res.json(await roles.updateRole(parse(IdParam, req.params).id, parse(UpdateRoleSchema, req.body)));
});

t.delete('/roles/:id', 'roles.gestionar', async (req, res) => {
  await roles.deleteRole(parse(IdParam, req.params).id);
  res.status(204).end();
});
