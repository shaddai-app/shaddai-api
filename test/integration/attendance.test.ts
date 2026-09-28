import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');
const code = (res: request.Response) => res.body.error?.code;

/** Culto semanal que empezó hace 3 semanas (fechas en -21, -14, -7, hoy, +7…). */
async function weeklyService(headers: Headers) {
  const first = addDays(today(), -21);
  const res = await request(app)
    .post(api('/events'))
    .set(headers)
    .send({
      type: 'service',
      title: 'Culto',
      startsAt: `${first}T10:00`,
      endsAt: `${first}T12:00`,
      recurrence: { freq: 'weekly', interval: 1 },
    })
    .expect(201);
  return { event: res.body, day: (weeks: number) => `${addDays(first, weeks * 7)}T10:00` };
}

const put = (headers: Headers, eventId: number, occurrence: string, body: object) =>
  request(app)
    .put(api(`/events/${eventId}/attendance/${occurrence}`))
    .set(headers)
    .send(body);
const list = async (headers: Headers, from = addDays(today(), -30), to = addDays(today(), -1)) =>
  (
    await request(app)
      .get(api(`/attendance?from=${from}&to=${to}`))
      .set(headers)
      .expect(200)
  ).body;

describe('asistencia a cultos', () => {
  it('carga, corrige y borra la asistencia de una fecha; pendientes y resumen', async () => {
    const c = await provisionChurch();
    const { event, day } = await weeklyService(c.headers);

    let data = await list(c.headers);
    expect(data.items.map((i: { originalStart: string }) => i.originalStart)).toEqual([
      day(2),
      day(1),
      day(0),
    ]);
    expect(data.summary).toMatchObject({ recorded: 0, pending: 3, avgInPerson: null, peak: null });

    const saved = await put(c.headers, event.id, day(1), {
      adults: 80,
      children: 20,
      newcomers: 5,
      online: 30,
      notes: 'Santa cena',
    }).expect(200);
    expect(saved.body.attendance).toMatchObject({ adults: 80, children: 20, inPerson: 100, online: 30 });
    // Corregir es la misma operación (una fila por fecha).
    await put(c.headers, event.id, day(1), { adults: 90, children: 20, newcomers: 5 }).expect(200);
    await put(c.headers, event.id, day(0), { adults: 60, children: 10 }).expect(200);

    data = await list(c.headers);
    expect(data.summary).toMatchObject({
      recorded: 2,
      pending: 1,
      avgInPerson: 90,
      avgOnline: 0,
      newcomers: 5,
      peak: { inPerson: 110, startsAt: day(1) },
    });
    expect(data.items.find((i: { pending: boolean }) => i.pending).originalStart).toBe(day(2));
    expect(await prisma.serviceAttendance.count()).toBe(2);

    const one = await request(app)
      .get(api(`/events/${event.id}/attendance/${day(1)}`))
      .set(c.headers)
      .expect(200);
    expect(one.body).toMatchObject({
      started: true,
      cancelled: false,
      attendance: { adults: 90, notes: null },
    });

    // Validaciones: fecha futura, fecha que no es de la serie, nuevos de más, fecha cancelada.
    expect(code(await put(c.headers, event.id, day(5), { adults: 1 }))).toBe('ATTENDANCE_FUTURE');
    expect(code(await put(c.headers, event.id, `${addDays(today(), -20)}T10:00`, { adults: 1 }))).toBe(
      'OCCURRENCE_INVALID',
    );
    expect(code(await put(c.headers, event.id, day(2), { adults: 3, children: 1, newcomers: 5 }))).toBe(
      'ATTENDANCE_NEWCOMERS_EXCEED',
    );
    await request(app)
      .put(api(`/events/${event.id}/exceptions`))
      .set(c.headers)
      .send({ originalStart: day(2), cancelled: true })
      .expect(200);
    expect(code(await put(c.headers, event.id, day(2), { adults: 1 }))).toBe('OCCURRENCE_CANCELLED');
    data = await list(c.headers);
    expect(data.summary.pending).toBe(0);
    expect(data.items.find((i: { originalStart: string }) => i.originalStart === day(2)).cancelled).toBe(
      true,
    );

    await request(app)
      .delete(api(`/events/${event.id}/attendance/${day(0)}`))
      .set(c.headers)
      .expect(204);
    data = await list(c.headers);
    expect(data.summary).toMatchObject({ recorded: 1, pending: 1 });

    const xlsx = await request(app)
      .get(api(`/attendance?from=${addDays(today(), -30)}&to=${today()}&format=xlsx`))
      .set(c.headers)
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });

  it('la asistencia sigue a su fecha si cambia el horario o se parte la serie', async () => {
    const c = await provisionChurch();
    const { event, day } = await weeklyService(c.headers);
    await put(c.headers, event.id, day(0), { adults: 50 }).expect(200);
    await put(c.headers, event.id, day(2), { adults: 70 }).expect(200);

    // Pasa a las 11: cada fila va a la fecha del mismo día con el horario nuevo.
    const first = day(0).slice(0, 10);
    await request(app)
      .patch(api(`/events/${event.id}`))
      .set(c.headers)
      .send({ startsAt: `${first}T11:00`, endsAt: `${first}T13:00` })
      .expect(200);
    const at11 = (weeks: number) => day(weeks).replace('T10:00', 'T11:00');
    let rows = await prisma.serviceAttendance.findMany({ orderBy: { occurrenceStart: 'asc' } });
    expect(rows.map((r) => r.occurrenceStart.toISOString().slice(0, 16))).toEqual([at11(0), at11(2)]);

    // Desde la semana 1 sigue un evento nuevo: la asistencia de la semana 2 se va con él.
    const split = await request(app)
      .post(api(`/events/${event.id}/split`))
      .set(c.headers)
      .send({ occurrence: at11(1), title: 'Culto (nuevo horario)' })
      .expect(201);
    rows = await prisma.serviceAttendance.findMany({ orderBy: { occurrenceStart: 'asc' } });
    expect(rows.map((r) => r.eventId)).toEqual([event.id, split.body.id]);
    const data = await list(c.headers);
    expect(data.items.map((i: { title: string }) => i.title)).toEqual([
      'Culto (nuevo horario)',
      'Culto (nuevo horario)',
      'Culto',
    ]);
  });

  it('permisos y aislamiento entre iglesias', async () => {
    const c = await provisionChurch();
    const { event, day } = await weeklyService(c.headers);
    const viewer = await actor({ 'asistencia.ver': 'all' }, c.accountId);
    await request(app)
      .get(api(`/events/${event.id}/attendance/${day(0)}`))
      .set(viewer.headers)
      .expect(200);
    expect((await put(viewer.headers, event.id, day(0), { adults: 1 })).status).toBe(403);
    const loader = await actor({ 'asistencia.registrar': 'all' }, c.accountId);
    await put(loader.headers, event.id, day(0), { adults: 12 }).expect(200);
    // Quien carga también ve el listado (para encontrar los pendientes).
    expect((await list(loader.headers)).summary).toMatchObject({ recorded: 1, pending: 2 });
    const nobody = await actor({ 'eventos.ver': 'all' }, c.accountId);
    expect(
      (await request(app).get(api('/attendance?from=2026-01-01&to=2026-01-31')).set(nobody.headers)).status,
    ).toBe(403);

    const other = await provisionChurch();
    expect(code(await put(other.headers, event.id, day(0), { adults: 1 }))).toBe('EVENT_NOT_FOUND');
    expect((await list(other.headers)).items).toEqual([]);
  });
});
