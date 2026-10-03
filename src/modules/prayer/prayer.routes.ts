import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { authOf } from '../../core/middleware/authenticate.js';
import * as prayer from './prayer.service.js';

const t = tenantRouter();
export const prayerRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const viewer = (req: Parameters<typeof authOf>[0]) => prayer.viewerOf(authOf(req).userId);

// Cualquier usuario de la iglesia comparte peticiones y ve las que le corresponden.
t.get('/prayer-requests', 'account-user', async (req, res) => {
  res.json(await prayer.list(await viewer(req), parse(prayer.PrayerQuery, req.query)));
});

// Antes de /prayer-requests/:id.
t.get('/prayer-requests/context', 'account-user', async (req, res) => {
  res.json(await prayer.context(await viewer(req)));
});

t.get('/prayer-requests/:id', 'account-user', async (req, res) => {
  res.json(await prayer.get(await viewer(req), parse(IdParam, req.params).id));
});

t.post('/prayer-requests', 'account-user', async (req, res) => {
  const input = parse(prayer.CreatePrayerSchema, req.body);
  res.status(201).json(await prayer.create(await viewer(req), input));
});

t.patch('/prayer-requests/:id', 'account-user', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(prayer.UpdatePrayerSchema, req.body);
  res.json(await prayer.update(await viewer(req), id, input));
});

t.delete('/prayer-requests/:id', 'account-user', async (req, res) => {
  await prayer.remove(await viewer(req), parse(IdParam, req.params).id);
  res.status(204).end();
});

t.put('/prayer-requests/:id/praying', 'account-user', async (req, res) => {
  res.json(await prayer.startPraying(await viewer(req), parse(IdParam, req.params).id));
});

t.delete('/prayer-requests/:id/praying', 'account-user', async (req, res) => {
  res.json(await prayer.stopPraying(await viewer(req), parse(IdParam, req.params).id));
});
