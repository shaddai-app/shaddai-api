import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

async function post(headers: Headers, url: string, body: object, status = 201) {
  const res = await request(app).post(api(url)).set(headers).send(body);
  if (res.status !== status) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const put = (headers: Headers, url: string, body: object) =>
  request(app).put(api(url)).set(headers).send(body);
const month = async (headers: Headers, from: string, to: string, types?: string) =>
  (
    await request(app)
      .get(api(`/calendar?from=${from}&to=${to}${types ? `&types=${types}` : ''}`))
      .set(headers)
  ).body.items as {
    key: string;
    startsAt: string;
    endsAt: string;
    cancelled: boolean;
    moved: boolean;
    note: string | null;
    title: string;
    source: string;
    eventId: number | null;
  }[];

/** Culto de los domingos de 10 a 12, desde el 6/9/2026. */
const sundayService = (headers: Headers, extra: object = {}) =>
  post(headers, '/events', {
    type: 'service',
    title: 'Culto dominical',
    startsAt: '2026-09-06T10:00',
    endsAt: '2026-09-06T12:00',
    recurrence: { freq: 'weekly' },
    ...extra,
  });

describe('calendario', () => {
  it('culto semanal con un feriado cancelado y una fecha movida (incluso a otro mes)', async () => {
    const c = await provisionChurch();
    const event = await sundayService(c.headers);
    expect(event).toMatchObject({ recurrence: { freq: 'weekly', interval: 1, weekdays: [0], until: null } });

    let oct = await month(c.headers, '2026-10-01', '2026-10-31');
    expect(oct.map((o) => o.startsAt)).toEqual([
      '2026-10-04T10:00',
      '2026-10-11T10:00',
      '2026-10-18T10:00',
      '2026-10-25T10:00',
    ]);

    await put(c.headers, `/events/${event.id}/exceptions`, {
      originalStart: '2026-10-11T10:00',
      cancelled: true,
      note: 'Feriado',
    }).expect(200);
    await put(c.headers, `/events/${event.id}/exceptions`, {
      originalStart: '2026-10-18T10:00',
      newStartsAt: '2026-10-17T18:00',
    }).expect(200);
    // El 1/11 pasa al sábado 31/10: aparece en octubre aunque la fecha original sea de noviembre.
    await put(c.headers, `/events/${event.id}/exceptions`, {
      originalStart: '2026-11-01T10:00',
      newStartsAt: '2026-10-31T19:00',
      newEndsAt: '2026-10-31T21:30',
    }).expect(200);

    oct = await month(c.headers, '2026-10-01', '2026-10-31');
    expect(oct.map((o) => [o.startsAt, o.endsAt, o.cancelled, o.moved, o.note])).toEqual([
      ['2026-10-04T10:00', '2026-10-04T12:00', false, false, null],
      ['2026-10-11T10:00', '2026-10-11T12:00', true, false, 'Feriado'],
      ['2026-10-17T18:00', '2026-10-17T20:00', false, true, null],
      ['2026-10-25T10:00', '2026-10-25T12:00', false, false, null],
      ['2026-10-31T19:00', '2026-10-31T21:30', false, true, null],
    ]);
    const nov = await month(c.headers, '2026-11-01', '2026-11-08');
    expect(nov.map((o) => o.startsAt)).toEqual(['2026-11-08T10:00']);

    const bad = await put(c.headers, `/events/${event.id}/exceptions`, {
      originalStart: '2026-10-12T10:00',
      cancelled: true,
    });
    expect(bad.body.error.code).toBe('OCCURRENCE_INVALID');
    const far = await put(c.headers, `/events/${event.id}/exceptions`, {
      originalStart: '2026-10-25T10:00',
      newStartsAt: '2026-12-25T10:00',
    });
    expect(far.body.error.code).toBe('EXCEPTION_TOO_FAR');

    // Quitar la excepción vuelve la fecha a la normalidad.
    await request(app)
      .delete(api(`/events/${event.id}/exceptions?originalStart=2026-10-11T10:00`))
      .set(c.headers)
      .expect(200);
    oct = await month(c.headers, '2026-10-01', '2026-10-31');
    expect(oct[1]).toMatchObject({ startsAt: '2026-10-11T10:00', cancelled: false });
  });

  it('editar la serie descarta las excepciones que ya no corresponden; partirla cambia desde una fecha', async () => {
    const c = await provisionChurch();
    const event = await sundayService(c.headers);
    await put(c.headers, `/events/${event.id}/exceptions`, {
      originalStart: '2026-10-11T10:00',
      cancelled: true,
    }).expect(200);

    const renamed = await request(app)
      .patch(api(`/events/${event.id}`))
      .set(c.headers)
      .send({ title: 'Culto' });
    expect(renamed.body).toMatchObject({ title: 'Culto', removedExceptions: 0 });
    expect(renamed.body.exceptions).toHaveLength(1);

    // Esta fecha y las siguientes: desde el 8/11 el culto pasa a las 11.
    const later = await post(c.headers, `/events/${event.id}/split`, {
      occurrence: '2026-11-08T10:00',
      startsAt: '2026-11-08T11:00',
      endsAt: '2026-11-08T13:00',
    });
    expect(later).toMatchObject({ startsAt: '2026-11-08T11:00', recurrence: { freq: 'weekly' } });
    const nov = await month(c.headers, '2026-11-01', '2026-11-22');
    expect(nov.map((o) => [o.startsAt, o.eventId])).toEqual([
      ['2026-11-01T10:00', event.id],
      ['2026-11-08T11:00', later.id],
      ['2026-11-15T11:00', later.id],
      ['2026-11-22T11:00', later.id],
    ]);
    const first = await request(app)
      .post(api(`/events/${event.id}/split`))
      .set(c.headers)
      .send({ occurrence: '2026-09-06T10:00', title: 'x' });
    expect(first.body.error.code).toBe('SPLIT_AT_FIRST');

    // Cambiar la hora de toda la serie original descarta la excepción del 11/10 (ya no es fecha).
    const moved = await request(app)
      .patch(api(`/events/${event.id}`))
      .set(c.headers)
      .send({ startsAt: '2026-09-06T09:00', endsAt: '2026-09-06T11:00' });
    expect(moved.body.removedExceptions).toBe(1);
    const single = await post(c.headers, '/events', {
      type: 'special',
      title: 'Bautismos',
      startsAt: '2026-10-10T16:00',
      endsAt: '2026-10-10T18:00',
    });
    const notRecurring = await put(c.headers, `/events/${single.id}/exceptions`, {
      originalStart: '2026-10-10T16:00',
      cancelled: true,
    });
    expect(notRecurring.body.error.code).toBe('EVENT_NOT_RECURRING');
  });

  it('eventos de todo el día y de varios días, validaciones y filtro por tipo', async () => {
    const c = await provisionChurch();
    const retreat = await post(c.headers, '/events', {
      type: 'special',
      title: 'Retiro de jóvenes',
      startsAt: '2026-10-09T08:00',
      endsAt: '2026-10-11T12:00',
      allDay: true,
      location: 'Campamento',
    });
    expect(retreat).toMatchObject({ startsAt: '2026-10-09T00:00', endsAt: '2026-10-11T23:59', allDay: true });
    // Se ve en un período que solo toca su último día.
    expect((await month(c.headers, '2026-10-11', '2026-10-20')).map((o) => o.title)).toEqual([
      'Retiro de jóvenes',
    ]);
    await sundayService(c.headers);
    expect((await month(c.headers, '2026-10-01', '2026-10-07', 'special')).map((o) => o.title)).toEqual([]);
    expect((await month(c.headers, '2026-10-01', '2026-10-07', 'service')).map((o) => o.title)).toEqual([
      'Culto dominical',
    ]);

    const code = async (body: object) =>
      (await request(app).post(api('/events')).set(c.headers).send(body)).body.error.code;
    const base = { type: 'meeting', title: 'X' };
    expect(await code({ ...base, startsAt: '2026-10-10T10:00', endsAt: '2026-10-10T09:00' })).toBe(
      'EVENT_RANGE_INVALID',
    );
    expect(await code({ ...base, startsAt: '2026-10-01T10:00', endsAt: '2026-10-30T10:00' })).toBe(
      'EVENT_TOO_LONG',
    );
    expect(
      await code({
        ...base,
        startsAt: '2026-10-10T10:00',
        endsAt: '2026-10-10T11:00',
        recurrence: { freq: 'weekly', until: '2026-10-01' },
      }),
    ).toBe('RECURRENCE_UNTIL_INVALID');
    const long = await request(app).get(api('/calendar?from=2026-01-01&to=2026-12-31')).set(c.headers);
    expect(long.body.error.code).toBe('CALENDAR_RANGE_TOO_LONG');

    await request(app)
      .delete(api(`/events/${retreat.id}`))
      .set(c.headers)
      .expect(204);
    expect((await month(c.headers, '2026-10-09', '2026-10-11', 'special')).length).toBe(0);
    await request(app)
      .get(api(`/events/${retreat.id}`))
      .set(c.headers)
      .expect(404);
  });

  it('las reuniones de célula aparecen según lo que cada uno puede ver', async () => {
    const c = await provisionChurch();
    const network = await post(c.headers, '/networks', { name: 'Red' });
    const zone = await post(c.headers, '/zones', { name: 'Zona', networkId: network.id });
    const person = async (firstName: string) =>
      (await post(c.headers, '/people', { firstName, lastName: 'Test', allowDuplicate: true })).id as number;
    const [a, b] = [await person('LíderA'), await person('LíderB')];
    const base = { meetingDay: 3, meetingTime: '20:00', address: 'Calle 1', zoneId: zone.id };
    await post(c.headers, '/cells', { ...base, name: 'Célula A', leaderPersonId: a });
    await post(c.headers, '/cells', { ...base, name: 'Célula B', leaderPersonId: b });
    const leader = await actor({ 'eventos.ver': 'all', 'celulas.ver': 'own' }, c.accountId);
    await prisma.user.update({ where: { id: leader.user.id }, data: { personId: a } });
    const viewerOnly = await actor({ 'eventos.ver': 'all' }, c.accountId);

    const all = await month(c.headers, '2026-10-05', '2026-10-11', 'cell');
    expect(all.map((o) => [o.title, o.startsAt, o.endsAt])).toEqual([
      ['Célula A', '2026-10-07T20:00', '2026-10-07T22:00'],
      ['Célula B', '2026-10-07T20:00', '2026-10-07T22:00'],
    ]);
    expect((await month(leader.headers, '2026-10-05', '2026-10-11')).map((o) => o.title)).toEqual([
      'Célula A',
    ]);
    expect(await month(viewerOnly.headers, '2026-10-05', '2026-10-11')).toEqual([]);
  });

  it('permisos y aislamiento entre iglesias', async () => {
    const c = await provisionChurch();
    const event = await sundayService(c.headers);
    const viewer = await actor({ 'eventos.ver': 'all' }, c.accountId);
    await request(app)
      .get(api(`/events/${event.id}`))
      .set(viewer.headers)
      .expect(200);
    await request(app)
      .post(api('/events'))
      .set(viewer.headers)
      .send({ type: 'other', title: 'X', startsAt: '2026-10-10T10:00', endsAt: '2026-10-10T11:00' })
      .expect(403);
    const other = await provisionChurch();
    await request(app)
      .get(api(`/events/${event.id}`))
      .set(other.headers)
      .expect(404);
    await request(app)
      .patch(api(`/events/${event.id}`))
      .set(other.headers)
      .send({ title: 'x' })
      .expect(404);
    expect(await month(other.headers, '2026-10-01', '2026-10-31')).toEqual([]);
  });
});
