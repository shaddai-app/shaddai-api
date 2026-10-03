import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { authOf } from '../../core/middleware/authenticate.js';
import { hasPermission } from '../../core/middleware/authorize.js';
import * as announcements from './announcements.service.js';

const t = tenantRouter();
export const announcementsRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

// Cualquier usuario: los anuncios que le corresponden.
t.get('/announcements', 'account-user', async (req, res) => {
  res.json(await announcements.feed(authOf(req).userId, parse(announcements.FeedQuery, req.query)));
});

// Antes de /announcements/:id.
t.get('/announcements/manage', 'anuncios.gestionar', async (req, res) => {
  res.json(await announcements.listForManagers(parse(announcements.ManageQuery, req.query)));
});

t.get('/announcements/audience-options', 'anuncios.gestionar', async (_req, res) => {
  res.json(await announcements.audienceOptions());
});

t.get('/announcements/:id', 'account-user', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const canManage = await hasPermission(req, 'anuncios.gestionar');
  res.json(await announcements.getVisible(authOf(req).userId, id, canManage));
});

t.post('/announcements', 'anuncios.gestionar', async (req, res) => {
  const input = parse(announcements.CreateAnnouncementSchema, req.body);
  res.status(201).json(await announcements.createAnnouncement(authOf(req).userId, input));
});

t.patch('/announcements/:id', 'anuncios.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(announcements.UpdateAnnouncementSchema, req.body);
  res.json(await announcements.updateAnnouncement(authOf(req).userId, id, input));
});

t.delete('/announcements/:id', 'anuncios.gestionar', async (req, res) => {
  await announcements.deleteAnnouncement(parse(IdParam, req.params).id);
  res.status(204).end();
});
