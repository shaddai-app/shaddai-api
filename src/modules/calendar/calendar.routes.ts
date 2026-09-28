import { z } from 'zod';
import { writeXlsx } from '../../core/excel/spreadsheet.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as calendar from './calendar.service.js';
import * as registrations from './registrations.service.js';

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

// ───────────── Inscripciones ─────────────

t.get('/events/:id/registrations', 'eventos.inscripciones', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { occurrence, format } = parse(
    registrations.OccurrenceQuery.extend({ format: z.enum(['json', 'xlsx']).default('json') }),
    req.query,
  );
  const data = await registrations.listRegistrations(id, occurrence);
  if (format === 'json') {
    res.json(data);
    return;
  }
  const { locale } = parse(z.object({ locale: z.enum(['es', 'en', 'pt']).default('es') }), req.query);
  const headers = REGISTRATION_HEADERS[locale];
  const status = STATUS_LABELS[locale];
  const rows = data.items.map((r) => [
    r.name,
    r.email,
    r.phone,
    status[r.status as keyof typeof status] ?? r.status,
    r.paidAmount,
    r.notes,
  ]);
  res
    .attachment(`inscriptos-${id}-${occurrence.slice(0, 10)}.xlsx`)
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(await writeXlsx(data.event.title, headers, rows));
});

t.post('/events/:id/registrations', 'eventos.inscripciones', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(registrations.RegistrationSchema, req.body);
  res.status(201).json(await registrations.createRegistration(await viewerOf(req), id, input));
});

t.post('/registrations/:id/cancel', 'eventos.inscripciones', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await registrations.cancelRegistration(id));
});

/** Pago manual: además pide finanzas.registrar (lo valida el servicio). */
t.post('/registrations/:id/payment', 'eventos.inscripciones', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(registrations.PaymentSchema, req.body);
  res.status(201).json(await registrations.registerPayment(await viewerOf(req), id, input));
});

const REGISTRATION_HEADERS = {
  es: ['Nombre', 'Email', 'Teléfono', 'Estado', 'Pagó', 'Notas'],
  en: ['Name', 'Email', 'Phone', 'Status', 'Paid', 'Notes'],
  pt: ['Nome', 'Email', 'Telefone', 'Situação', 'Pagou', 'Observações'],
};
const STATUS_LABELS = {
  es: { confirmed: 'Confirmado', waitlist: 'Lista de espera', cancelled: 'Cancelado' },
  en: { confirmed: 'Confirmed', waitlist: 'Waitlist', cancelled: 'Cancelled' },
  pt: { confirmed: 'Confirmado', waitlist: 'Lista de espera', cancelled: 'Cancelado' },
};
