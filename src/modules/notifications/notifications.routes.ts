import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { forbidImpersonation } from '../../core/middleware/authenticate.js';
import { viewerOf } from '../people/people.scope.js';
import * as notifications from './notifications.service.js';

const t = tenantRouter();
export const notificationsRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

// Cada usuario ve solo sus avisos.
t.get('/notifications', 'account-user', async (req, res) => {
  const { userId } = await viewerOf(req);
  res.json(await notifications.listNotifications(userId, parse(notifications.ListQuery, req.query)));
});

t.get('/notifications/unread-count', 'account-user', async (req, res) => {
  const { userId } = await viewerOf(req);
  res.json(await notifications.unreadCount(userId));
});

t.post('/notifications/read-all', 'account-user', async (req, res) => {
  const { userId } = await viewerOf(req);
  res.json(await notifications.markAllRead(userId));
});

t.post('/notifications/:id/read', 'account-user', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { userId } = await viewerOf(req);
  res.json(await notifications.markRead(userId, id));
});

t.get('/me/notification-prefs', 'account-user', async (req, res) => {
  const { userId } = await viewerOf(req);
  res.json(await notifications.getPrefs(userId));
});

t.patch('/me/notification-prefs', 'account-user', forbidImpersonation, async (req, res) => {
  const { userId } = await viewerOf(req);
  res.json(await notifications.setPrefs(userId, parse(notifications.PrefsSchema, req.body)));
});
