import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { authOf } from '../../core/middleware/authenticate.js';
import {
  CreateUserSchema,
  IdParam,
  ListUsersQuery,
  ResetPasswordSchema,
  UpdateUserSchema,
} from './users.schemas.js';
import * as users from './users.service.js';

const t = tenantRouter();
export const usersRouter = t.router;

t.get('/users', 'usuarios.ver', async (req, res) => {
  res.json(await users.listUsers(parse(ListUsersQuery, req.query)));
});

t.get('/users/:id', 'usuarios.ver', async (req, res) => {
  res.json(await users.getUser(parse(IdParam, req.params).id));
});

// Devuelve temporaryPassword una sola vez (el front la muestra para copiar).
t.post('/users', 'usuarios.gestionar', async (req, res) => {
  res.status(201).json(await users.createUser(parse(CreateUserSchema, req.body)));
});

t.patch('/users/:id', 'usuarios.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await users.updateUser(authOf(req).userId, id, parse(UpdateUserSchema, req.body)));
});

t.post('/users/:id/activate', 'usuarios.gestionar', async (req, res) => {
  res.json(await users.setActive(authOf(req).userId, parse(IdParam, req.params).id, true));
});

t.post('/users/:id/deactivate', 'usuarios.gestionar', async (req, res) => {
  res.json(await users.setActive(authOf(req).userId, parse(IdParam, req.params).id, false));
});

t.post('/users/:id/unlock', 'usuarios.gestionar', async (req, res) => {
  res.json(await users.unlock(parse(IdParam, req.params).id));
});

t.post('/users/:id/reset-2fa', 'usuarios.resetear', async (req, res) => {
  res.json(await users.resetTwoFactor(authOf(req).userId, parse(IdParam, req.params).id));
});

t.post('/users/:id/reset-password', 'usuarios.resetear', async (req, res) => {
  const { sendAccessEmail } = parse(ResetPasswordSchema, req.body ?? {});
  res.json(await users.resetPassword(authOf(req).userId, parse(IdParam, req.params).id, sendAccessEmail));
});
