import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as calendar from './calendar.service.js';

const t = tenantRouter();
export const calendarRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

t.get('/calendar', 'eventos.ver', async (req, res) => {
  res.json(await calendar.calendar(await viewerOf(req), parse(calendar.CalendarQuery, req.query)));
});

t.get('/events/:id', 'eventos.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await calendar.getEvent(id));
});

t.post('/events', 'eventos.gestionar', async (req, res) => {
  const input = parse(calendar.CreateEventSchema, req.body);
  res.status(201).json(await calendar.createEvent(await viewerOf(req), input));
});

t.patch('/events/:id', 'eventos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await calendar.updateEvent(id, parse(calendar.UpdateEventSchema, req.body)));
});

/** Cambia "esta fecha y las siguientes" (parte la serie en dos). */
t.post('/events/:id/split', 'eventos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(calendar.SplitEventSchema, req.body);
  res.status(201).json(await calendar.splitEvent(await viewerOf(req), id, input));
});

t.delete('/events/:id', 'eventos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await calendar.deleteEvent(id);
  res.status(204).end();
});

/** Cancela o mueve una sola fecha de una serie. */
t.put('/events/:id/exceptions', 'eventos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await calendar.setException(id, parse(calendar.ExceptionSchema, req.body)));
});

t.delete('/events/:id/exceptions', 'eventos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { originalStart } = parse(
    z.object({ originalStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }),
    req.query,
  );
  res.json(await calendar.clearException(id, originalStart));
});
