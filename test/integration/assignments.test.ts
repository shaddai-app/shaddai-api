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

const send = (headers: Headers, method: 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) =>
  request(app)[method](api(url)).set(headers).send(body);
const get = (headers: Headers, url: string) => request(app).get(api(url)).set(headers);

async function person(headers: Headers, firstName: string) {
  const res = await send(headers, 'post', '/people', { firstName, lastName: 'Test', allowDuplicate: true });
  if (res.status !== 201) throw new Error(`persona: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

/** Iglesia con Alabanza (Ana y Beto integrantes) y un culto semanal que empieza mañana a las 10. */
async function setup() {
  const c = await provisionChurch();
  const ana = await person(c.headers, 'Ana');
  const beto = await person(c.headers, 'Beto');
  const caro = await person(c.headers, 'Caro'); // no integra el ministerio
  const worship = (await send(c.headers, 'post', '/ministries', { name: 'Alabanza', kind: 'worship' })).body;
  await send(c.headers, 'post', `/ministries/${worship.id}/members`, { personId: ana });
  await send(c.headers, 'post', `/ministries/${worship.id}/members`, { personId: beto });
  const first = addDays(today(), 1);
  const event = (
    await send(c.headers, 'post', '/events', {
      type: 'service',
      title: 'Culto',
      startsAt: `${first}T10:00`,
      endsAt: `${first}T12:00`,
      recurrence: { freq: 'weekly', interval: 1 },
    })
  ).body;
  const role = (name: string) => worship.roles.find((r: { name: string }) => r.name === name).id as number;
  const day = (weeks: number) => `${addDays(first, weeks * 7)}T10:00`;
  return { c, ana, beto, caro, worship, event, role, day };
}

describe('turnos', () => {
  it('asigna, valida y arma la grilla del ministerio', async () => {
    const { c, ana, beto, caro, worship, event, role, day } = await setup();
    const assign = (body: object) => send(c.headers, 'post', `/ministries/${worship.id}/assignments`, body);

    const res = await assign({
      eventId: event.id,
      occurrence: day(0),
      serviceRoleId: role('Voz'),
      personId: ana,
    });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([]);
    await assign({
      eventId: event.id,
      occurrence: day(0),
      serviceRoleId: role('Bajo'),
      personId: beto,
    }).expect(201);

    expect(
      code(
        await assign({ eventId: event.id, occurrence: day(0), serviceRoleId: role('Voz'), personId: ana }),
      ),
    ).toBe('ASSIGNMENT_EXISTS');
    expect(
      code(
        await assign({ eventId: event.id, occurrence: day(0), serviceRoleId: role('Voz'), personId: caro }),
      ),
    ).toBe('ASSIGNMENT_NOT_MEMBER');
    expect(
      code(
        await assign({
          eventId: event.id,
          occurrence: `${addDays(today(), 2)}T10:00`,
          serviceRoleId: role('Voz'),
          personId: ana,
        }),
      ),
    ).toBe('OCCURRENCE_INVALID');
    // Fecha cancelada y fecha pasada.
    await send(c.headers, 'put', `/events/${event.id}/exceptions`, {
      originalStart: day(2),
      cancelled: true,
    });
    expect(
      code(
        await assign({ eventId: event.id, occurrence: day(2), serviceRoleId: role('Voz'), personId: ana }),
      ),
    ).toBe('OCCURRENCE_CANCELLED');
    const yesterday = addDays(today(), -1);
    const past = (
      await send(c.headers, 'post', '/events', {
        type: 'service',
        title: 'Ayer',
        startsAt: `${yesterday}T10:00`,
        endsAt: `${yesterday}T11:00`,
      })
    ).body;
    expect(
      code(
        await assign({
          eventId: past.id,
          occurrence: `${yesterday}T10:00`,
          serviceRoleId: role('Voz'),
          personId: ana,
        }),
      ),
    ).toBe('ASSIGNMENT_PAST');
    // Puesto inactivo, y un puesto con turnos no se borra.
    await send(c.headers, 'patch', `/ministries/${worship.id}/service-roles/${role('Teclado')}`, {
      isActive: false,
    });
    expect(
      code(
        await assign({
          eventId: event.id,
          occurrence: day(0),
          serviceRoleId: role('Teclado'),
          personId: ana,
        }),
      ),
    ).toBe('SERVICE_ROLE_INACTIVE');
    expect(
      code(await send(c.headers, 'delete', `/ministries/${worship.id}/service-roles/${role('Voz')}`)),
    ).toBe('SERVICE_ROLE_IN_USE');

    const s = (
      await get(c.headers, `/ministries/${worship.id}/schedule?from=${today()}&to=${addDays(today(), 20)}`)
    ).body;
    expect(s.canAssign).toBe(true);
    expect(s.occurrences.map((o: { originalStart: string }) => o.originalStart)).toEqual([
      day(0),
      day(1),
      day(2),
    ]);
    expect(s.occurrences[2].cancelled).toBe(true);
    expect(
      s.occurrences[0].assignments.map((a: { person: { id: number }; status: string }) => [
        a.person.id,
        a.status,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [ana, 'pending'],
        [beto, 'pending'],
      ]),
    );
    expect(s.roles.map((r: { name: string }) => r.name)).not.toContain('Teclado');
    expect(s.members.map((m: { id: number }) => m.id).sort()).toEqual([ana, beto].sort());

    // Quitar un turno.
    const annaId = s.occurrences[0].assignments.find(
      (a: { person: { id: number } }) => a.person.id === ana,
    ).id;
    await send(c.headers, 'delete', `/ministries/${worship.id}/assignments/${annaId}`).expect(204);
    expect(await prisma.serviceAssignment.count()).toBe(1);
  });

  it('mis turnos: responder, no disponibilidad y advertencias', async () => {
    const { c, ana, beto, worship, event, role, day } = await setup();
    const me = await actor({}, c.accountId);
    await prisma.user.update({ where: { id: me.user.id }, data: { personId: ana } });

    // Sin ficha vinculada no hay turnos ni se cargan fechas.
    const unlinked = await actor({}, c.accountId);
    expect((await get(unlinked.headers, '/me/assignments')).body).toEqual({ linked: false, items: [] });
    expect(
      code(
        await send(unlinked.headers, 'post', '/me/unavailability', { fromDate: today(), toDate: today() }),
      ),
    ).toBe('PERSON_NOT_LINKED');

    // Ana avisa que no está la semana 1: al asignarla se advierte (pero se asigna).
    const unavailable = await send(me.headers, 'post', '/me/unavailability', {
      fromDate: day(1).slice(0, 10),
      toDate: day(1).slice(0, 10),
      reason: 'Viaje',
    });
    expect(unavailable.status).toBe(201);
    expect(unavailable.body).toMatchObject({ conflicts: 0, linked: true, items: [{ reason: 'Viaje' }] });
    const warned = await send(c.headers, 'post', `/ministries/${worship.id}/assignments`, {
      eventId: event.id,
      occurrence: day(1),
      serviceRoleId: role('Voz'),
      personId: ana,
    });
    expect(warned.body.warnings).toEqual([{ code: 'UNAVAILABLE', reason: 'Viaje' }]);

    // Ya sirve en otro ministerio en esa fecha.
    const tech = (await send(c.headers, 'post', '/ministries', { name: 'Técnica', kind: 'tech' })).body;
    await send(c.headers, 'post', `/ministries/${tech.id}/members`, { personId: ana });
    await send(c.headers, 'post', `/ministries/${worship.id}/assignments`, {
      eventId: event.id,
      occurrence: day(0),
      serviceRoleId: role('Coros'),
      personId: ana,
    });
    await send(c.headers, 'post', `/ministries/${worship.id}/assignments`, {
      eventId: event.id,
      occurrence: day(0),
      serviceRoleId: role('Batería'),
      personId: beto,
    });
    const sound = tech.roles.find((r: { name: string }) => r.name === 'Sonido').id;
    const double = await send(c.headers, 'post', `/ministries/${tech.id}/assignments`, {
      eventId: event.id,
      occurrence: day(0),
      serviceRoleId: sound,
      personId: ana,
    });
    expect(double.body.warnings).toEqual([{ code: 'ALREADY_ASSIGNED', ministry: 'Alabanza', role: 'Coros' }]);
    const grid = (
      await get(c.headers, `/ministries/${tech.id}/schedule?from=${today()}&to=${addDays(today(), 9)}`)
    ).body;
    expect(grid.elsewhere).toEqual(
      expect.arrayContaining([
        { personId: ana, eventId: event.id, occurrence: day(0), ministry: 'Alabanza', role: 'Coros' },
      ]),
    );

    // Mis turnos: con el equipo de esa fecha.
    let mine = (await get(me.headers, '/me/assignments')).body;
    expect(mine.linked).toBe(true);
    expect(mine.items.map((i: { role: string }) => i.role)).toEqual(['Coros', 'Sonido', 'Voz']);
    const coros = mine.items[0];
    expect(coros).toMatchObject({ status: 'pending', ministry: { name: 'Alabanza' }, occurrence: day(0) });
    expect(coros.team).toEqual([
      { role: 'Batería', status: 'pending', person: expect.objectContaining({ id: beto }) },
    ]);

    mine = (await send(me.headers, 'post', `/me/assignments/${coros.id}/respond`, { response: 'accept' }))
      .body;
    expect(mine.items[0].status).toBe('accepted');
    const voz = mine.items.find((i: { role: string }) => i.role === 'Voz');
    mine = (
      await send(me.headers, 'post', `/me/assignments/${voz.id}/respond`, {
        response: 'decline',
        reason: 'De viaje',
      })
    ).body;
    expect(mine.items.find((i: { id: number }) => i.id === voz.id)).toMatchObject({
      status: 'declined',
      declineReason: 'De viaje',
    });
    // No se responde un turno ajeno.
    const other = await actor({}, c.accountId);
    await prisma.user.update({ where: { id: other.user.id }, data: { personId: beto } });
    expect(
      code(await send(other.headers, 'post', `/me/assignments/${coros.id}/respond`, { response: 'decline' })),
    ).toBe('ASSIGNMENT_NOT_FOUND');

    // Borrar la no disponibilidad.
    const list = (await get(me.headers, '/me/unavailability')).body;
    expect((await send(me.headers, 'delete', `/me/unavailability/${list.items[0].id}`)).body.items).toEqual(
      [],
    );
    expect(code(await send(other.headers, 'delete', `/me/unavailability/${list.items[0].id}`))).toBe(
      'UNAVAILABILITY_NOT_FOUND',
    );
  });

  it('los turnos siguen a su fecha y se quitan al salir del ministerio; permisos', async () => {
    const { c, ana, beto, worship, event, role, day } = await setup();
    for (const [personId, weeks] of [
      [ana, 0],
      [ana, 1],
      [beto, 1],
    ] as const) {
      await send(c.headers, 'post', `/ministries/${worship.id}/assignments`, {
        eventId: event.id,
        occurrence: day(weeks),
        serviceRoleId: role('Voz'),
        personId,
      }).expect(201);
    }
    // El culto pasa a las 11: los turnos van a la fecha del mismo día con el horario nuevo.
    const first = day(0).slice(0, 10);
    await send(c.headers, 'patch', `/events/${event.id}`, {
      startsAt: `${first}T11:00`,
      endsAt: `${first}T13:00`,
    });
    const starts = async () =>
      (await prisma.serviceAssignment.findMany({ orderBy: { id: 'asc' } })).map((a) =>
        a.occurrenceStart.toISOString().slice(0, 16),
      );
    expect(await starts()).toEqual([day(0), day(1), day(1)].map((d) => d.replace('T10:00', 'T11:00')));

    // Beto sale del ministerio: se le quitan los turnos futuros.
    const detail = (await get(c.headers, `/ministries/${worship.id}`)).body;
    const betoMember = detail.members.find((m: { person: { id: number } }) => m.person.id === beto);
    await send(c.headers, 'delete', `/ministries/${worship.id}/members/${betoMember.id}`);
    expect(await prisma.serviceAssignment.count({ where: { personId: beto } })).toBe(0);

    // Solo ver: la grilla sí, asignar no. Un líder propio asigna en su ministerio y no en otros.
    const viewer = await actor({ 'ministerios.ver': 'all' }, c.accountId);
    expect(
      (await get(viewer.headers, `/ministries/${worship.id}/schedule?from=${today()}&to=${today()}`)).body,
    ).toMatchObject({ canAssign: false });
    expect(
      (
        await send(viewer.headers, 'post', `/ministries/${worship.id}/assignments`, {
          eventId: event.id,
          occurrence: day(2).replace('T10:00', 'T11:00'),
          serviceRoleId: role('Voz'),
          personId: ana,
        })
      ).status,
    ).toBe(403);
    const leader = await actor({ 'ministerios.ver': 'own', 'ministerios.turnos': 'own' }, c.accountId);
    await prisma.user.update({ where: { id: leader.user.id }, data: { personId: ana } });
    await prisma.ministryMember.updateMany({ where: { personId: ana }, data: { role: 'leader' } });
    const tech = (await send(c.headers, 'post', '/ministries', { name: 'Técnica', kind: 'tech' })).body;
    expect(
      (
        await send(leader.headers, 'post', `/ministries/${worship.id}/assignments`, {
          eventId: event.id,
          occurrence: day(2).replace('T10:00', 'T11:00'),
          serviceRoleId: role('Coros'),
          personId: ana,
        })
      ).status,
    ).toBe(201);
    expect(
      code(await get(leader.headers, `/ministries/${tech.id}/schedule?from=${today()}&to=${today()}`)),
    ).toBe('MINISTRY_NOT_FOUND');

    const other = await provisionChurch();
    expect(
      code(await get(other.headers, `/ministries/${worship.id}/schedule?from=${today()}&to=${today()}`)),
    ).toBe('MINISTRY_NOT_FOUND');
  });
});
