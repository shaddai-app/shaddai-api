import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');

async function post(headers: Headers, url: string, body: object, status = 201) {
  const res = await request(app).post(api(url)).set(headers).send(body);
  if (res.status !== status) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const code = (res: request.Response) => res.body.error?.code;
const list = async (headers: Headers, eventId: number, occurrence: string) =>
  (
    await request(app)
      .get(api(`/events/${eventId}/registrations?occurrence=${occurrence}`))
      .set(headers)
  ).body;

/** Evento especial dentro de 10 días, con inscripción. */
async function special(headers: Headers, extra: object = {}) {
  const day = addDays(today(), 10);
  const event = await post(headers, '/events', {
    type: 'special',
    title: 'Cena de matrimonios',
    startsAt: `${day}T20:00`,
    endsAt: `${day}T23:00`,
    registrationEnabled: true,
    capacity: 2,
    waitlistEnabled: true,
    ...extra,
  });
  return { event, occurrence: `${day}T20:00` };
}

describe('inscripciones', () => {
  it('cupo, lista de espera por orden de llegada y promoción al cancelar o ampliar el cupo', async () => {
    const c = await provisionChurch();
    const { event, occurrence } = await special(c.headers);
    expect(event).toMatchObject({ registrationEnabled: true, capacity: 2, waitlistEnabled: true });
    const person = (
      await post(c.headers, '/people', {
        firstName: 'Ana',
        lastName: 'Paz',
        phone: '1144445555',
        allowDuplicate: true,
      })
    ).id;

    const ana = await post(c.headers, `/events/${event.id}/registrations`, { occurrence, personId: person });
    expect(ana).toMatchObject({
      name: 'Ana Paz',
      status: 'confirmed',
      phone: expect.stringContaining('1144445555'),
    });
    const beto = await post(c.headers, `/events/${event.id}/registrations`, {
      occurrence,
      name: 'Beto',
      email: 'beto@x.com',
    });
    const caro = await post(c.headers, `/events/${event.id}/registrations`, { occurrence, name: 'Caro' });
    const dani = await post(c.headers, `/events/${event.id}/registrations`, { occurrence, name: 'Dani' });
    expect([beto.status, caro.status, dani.status]).toEqual(['confirmed', 'waitlist', 'waitlist']);

    const dup = await request(app)
      .post(api(`/events/${event.id}/registrations`))
      .set(c.headers)
      .send({ occurrence, name: 'Beto otra vez', email: 'BETO@x.com' });
    expect(dup.body.error).toMatchObject({ code: 'REGISTRATION_EXISTS', details: { status: 'confirmed' } });

    let data = await list(c.headers, event.id, occurrence);
    expect(data).toMatchObject({ capacity: 2, confirmed: 2, waitlist: 2, available: 0, full: true });
    expect(data.items.map((r: { name: string }) => r.name)).toEqual(['Ana Paz', 'Beto', 'Caro', 'Dani']);

    // Cancela un confirmado: sube la primera de la lista de espera.
    const cancelled = await post(c.headers, `/registrations/${beto.id}/cancel`, {}, 200);
    expect(cancelled.promoted).toEqual([caro.id]);
    // Se amplía el cupo: sube el resto.
    await request(app)
      .patch(api(`/events/${event.id}`))
      .set(c.headers)
      .send({ capacity: 5 })
      .expect(200);
    data = await list(c.headers, event.id, occurrence);
    expect(data).toMatchObject({ confirmed: 3, waitlist: 0, available: 2 });
    expect(data.items.at(-1)).toMatchObject({ name: 'Beto', status: 'cancelled' });

    // Sin lista de espera, con el cupo lleno se rechaza.
    const { event: full, occurrence: occ2 } = await special(c.headers, {
      capacity: 1,
      waitlistEnabled: false,
    });
    await post(c.headers, `/events/${full.id}/registrations`, { occurrence: occ2, name: 'Uno' });
    expect(
      code(
        await request(app)
          .post(api(`/events/${full.id}/registrations`))
          .set(c.headers)
          .send({ occurrence: occ2, name: 'Dos' }),
      ),
    ).toBe('EVENT_FULL');
  });

  it('series: cupo por fecha, fechas inválidas, canceladas o pasadas, y cambio de horario', async () => {
    const c = await provisionChurch();
    const start = addDays(today(), -14);
    const event = await post(c.headers, '/events', {
      type: 'meeting',
      title: 'Taller',
      startsAt: `${start}T19:00`,
      endsAt: `${start}T21:00`,
      recurrence: { freq: 'weekly' },
      registrationEnabled: true,
      capacity: 1,
    });
    const next = `${addDays(start, 21)}T19:00`;
    const after = `${addDays(start, 28)}T19:00`;
    await post(c.headers, `/events/${event.id}/registrations`, { occurrence: next, name: 'A' });
    // Otra fecha tiene su propio cupo.
    await post(c.headers, `/events/${event.id}/registrations`, { occurrence: after, name: 'A' });
    const reg = (occurrence: string) =>
      request(app)
        .post(api(`/events/${event.id}/registrations`))
        .set(c.headers)
        .send({ occurrence, name: 'Z' });
    expect(code(await reg(`${addDays(start, 22)}T19:00`))).toBe('OCCURRENCE_INVALID');
    expect(code(await reg(`${start}T19:00`))).toBe('REGISTRATION_CLOSED');
    await request(app)
      .put(api(`/events/${event.id}/exceptions`))
      .set(c.headers)
      .send({ originalStart: after, cancelled: true })
      .expect(200);
    expect(code(await reg(after))).toBe('OCCURRENCE_CANCELLED');

    // El taller pasa a las 20: las inscripciones siguen a su fecha.
    await request(app)
      .patch(api(`/events/${event.id}`))
      .set(c.headers)
      .send({ startsAt: `${start}T20:00`, endsAt: `${start}T22:00` })
      .expect(200);
    const moved = `${addDays(start, 21)}T20:00`;
    expect((await list(c.headers, event.id, moved)).confirmed).toBe(1);

    await request(app)
      .patch(api(`/events/${event.id}`))
      .set(c.headers)
      .send({ registrationEnabled: false })
      .expect(200);
    expect(code(await reg(moved))).toBe('REGISTRATION_DISABLED');
  });

  it('pago manual: ingreso en la caja (categoría de inscripciones) y solo con permiso de finanzas', async () => {
    const c = await provisionChurch();
    const { event, occurrence } = await special(c.headers, { price: 5000, capacity: null });
    const reg = await post(c.headers, `/events/${event.id}/registrations`, { occurrence, name: 'Ana' });
    const box = (await request(app).get(api('/finance/accounts')).set(c.headers)).body.items[0].id as number;
    const paid = await post(c.headers, `/registrations/${reg.id}/payment`, { financeAccountId: box });
    expect(paid.paidAmount).toBe(5000);
    const movement = (
      await request(app)
        .get(api(`/finance/movements/${paid.movementId}`))
        .set(c.headers)
    ).body;
    expect(movement).toMatchObject({
      kind: 'income',
      amount: 5000,
      category: { systemKey: 'event_fees' },
      description: 'Cena de matrimonios · Ana',
    });
    expect((await list(c.headers, event.id, occurrence)).items[0]).toMatchObject({
      paidAmount: 5000,
      paymentMovementId: paid.movementId,
    });

    const staff = await actor({ 'eventos.ver': 'all', 'eventos.inscripciones': 'all' }, c.accountId);
    const forbidden = await request(app)
      .post(api(`/registrations/${reg.id}/payment`))
      .set(staff.headers)
      .send({ financeAccountId: box });
    expect(code(forbidden)).toBe('PAYMENT_FORBIDDEN');
    // Sin permiso de inscripciones no se ve el listado.
    const viewer = await actor({ 'eventos.ver': 'all' }, c.accountId);
    await request(app)
      .get(api(`/events/${event.id}/registrations?occurrence=${occurrence}`))
      .set(viewer.headers)
      .expect(403);
  });

  it('inscripción pública (con trampa para bots) y exportación a Excel', async () => {
    const c = await provisionChurch();
    const { slug } = await prisma.account.findUniqueOrThrow({
      where: { id: c.accountId },
      select: { slug: true },
    });
    const { event, occurrence } = await special(c.headers, { price: 1500 });
    await request(app)
      .get(api(`/public/${slug}/events/${event.id}`))
      .expect(404); // todavía no es público
    await request(app)
      .patch(api(`/events/${event.id}`))
      .set(c.headers)
      .send({ isPublic: true })
      .expect(200);

    const info = await request(app)
      .get(api(`/public/${slug}/events/${event.id}`))
      .expect(200);
    expect(info.body.event).toMatchObject({
      title: 'Cena de matrimonios',
      price: 1500,
      dates: [{ occurrence, full: false, available: 2 }],
    });
    expect(info.body.church.currency).toBe('ARS');

    const send = (body: object) =>
      request(app)
        .post(api(`/public/${slug}/events/${event.id}/register`))
        .send(body);
    expect((await send({ occurrence, name: 'Juan Público', phone: '11 5555 1111' })).body).toEqual({
      status: 'confirmed',
    });
    expect((await send({ occurrence, name: 'Bot', phone: '1', website: 'spam' })).status).toBe(201);
    expect(code(await send({ occurrence, name: 'Sin contacto' }))).toBe('VALIDATION_ERROR');
    const data = await list(c.headers, event.id, occurrence);
    expect(data.items.map((r: { name: string; source: string }) => [r.name, r.source])).toEqual([
      ['Juan Público', 'public'],
    ]);

    const xlsx = await request(app)
      .get(api(`/events/${event.id}/registrations?occurrence=${occurrence}&format=xlsx`))
      .set(c.headers);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');

    // Otra iglesia no ve ni inscribe en este evento.
    const other = await provisionChurch();
    await request(app)
      .get(api(`/events/${event.id}/registrations?occurrence=${occurrence}`))
      .set(other.headers)
      .expect(404);
    await request(app)
      .post(api(`/events/${event.id}/registrations`))
      .set(other.headers)
      .send({ occurrence, name: 'X' })
      .expect(404);
  });
});
