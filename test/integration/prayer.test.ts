import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const get = (h: Headers, path: string) => request(app).get(api(path)).set(h);
const send = (h: Headers, method: 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) =>
  request(app)[method](api(path)).set(h).send(body);
const bodies = async (h: Headers, tab = 'open') =>
  ((await get(h, `/prayer-requests?tab=${tab}`)).body.items as { body: string }[]).map((p) => p.body);

/** Le da al usuario una ficha de persona. */
async function withPerson(user: { id: number }, accountId: number, firstName: string) {
  const status = await prisma.catalogItem.findFirstOrThrow({ where: { accountId, type: 'person_status' } });
  const person = await prisma.person.create({
    data: { accountId, statusId: status.id, firstName, lastName: 'Prueba', searchText: firstName },
  });
  await prisma.user.update({ where: { id: user.id }, data: { personId: person.id } });
  return person;
}

/**
 * Iglesia con un líder de célula, un integrante de su célula, otro miembro sin célula y un pastor
 * (además del dueño, que tiene todos los permisos).
 */
async function setup() {
  const church = await provisionChurch();
  const { accountId } = church;
  const leader = await actor({}, accountId);
  const member = await actor({}, accountId);
  const outsider = await actor({}, accountId);
  const pastor = await actor({ 'oracion.pastoral': 'all' }, accountId);
  const leaderPerson = await withPerson(leader.user, accountId, 'Lidia');
  const memberPerson = await withPerson(member.user, accountId, 'Mario');
  await withPerson(outsider.user, accountId, 'Olga');
  const network = await prisma.network.create({ data: { accountId, name: 'Red' } });
  const zone = await prisma.zone.create({ data: { accountId, networkId: network.id, name: 'Zona' } });
  const cell = await prisma.cell.create({
    data: {
      accountId,
      zoneId: zone.id,
      name: 'Célula Centro',
      meetingDay: 3,
      meetingTime: '20:00',
      address: 'Calle 1',
      leaderPersonId: leaderPerson.id,
    },
  });
  await prisma.cellMember.createMany({
    data: [leaderPerson, memberPerson].map((p) => ({
      accountId,
      cellId: cell.id,
      personId: p.id,
      joinedAt: new Date(),
    })),
  });
  return { church, leader, member, outsider, pastor, cell, memberPerson };
}

describe('peticiones de oración', () => {
  it('visibilidad: pública para todos, de líder para su líder, de pastores solo para ellos', async () => {
    const { church, leader, member, outsider, pastor } = await setup();
    for (const visibility of ['public', 'leader', 'pastors']) {
      const res = await send(member.headers, 'post', '/prayer-requests', { body: visibility, visibility });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ mine: true, status: 'open', prayerCount: 0, praying: false });
    }
    expect(await bodies(member.headers)).toEqual(['pastors', 'leader', 'public']);
    expect(await bodies(leader.headers)).toEqual(['leader', 'public']);
    expect(await bodies(outsider.headers)).toEqual(['public']);
    expect(await bodies(pastor.headers)).toEqual(['pastors', 'leader', 'public']);
    expect(await bodies(church.headers)).toEqual(['pastors', 'leader', 'public']);

    const leaderOnly = (await get(member.headers, '/prayer-requests?tab=mine')).body.items[1];
    expect((await get(outsider.headers, `/prayer-requests/${leaderOnly.id}`)).status).toBe(404);
    expect((await get(leader.headers, `/prayer-requests/${leaderOnly.id}`)).status).toBe(200);

    // Avisos: la de líder al líder, la de pastores a los pastores (y al dueño); la pública a nadie.
    const notices = await prisma.notification.findMany({
      where: { type: 'prayer.request' },
      select: { userId: true, params: true, link: true },
    });
    const to = (visibility: string) =>
      notices
        .filter((n) => JSON.parse(n.params ?? '{}').visibility === visibility)
        .map((n) => n.userId)
        .sort((a, b) => a - b);
    expect(to('leader')).toEqual([leader.user.id]);
    expect(to('pastors')).toEqual([church.ownerId, pastor.user.id].sort((a, b) => a - b));
    expect(to('public')).toEqual([]);
    expect(notices.find((n) => n.userId === leader.user.id)!.link).toBe(`/oracion/${leaderOnly.id}`);
    // El texto de la petición no viaja en el aviso.
    expect(
      notices.every(
        (n) =>
          Object.keys(JSON.parse(n.params ?? '{}'))
            .sort()
            .join() === 'author,visibility',
      ),
    ).toBe(true);
  });

  it('si deja la célula, su líder deja de ver la petición', async () => {
    const { leader, member, memberPerson } = await setup();
    await send(member.headers, 'post', '/prayer-requests', { body: 'trabajo', visibility: 'leader' });
    expect(await bodies(leader.headers)).toEqual(['trabajo']);
    await prisma.cellMember.updateMany({
      where: { personId: memberPerson.id },
      data: { leftAt: new Date() },
    });
    expect(await bodies(leader.headers)).toEqual([]);
    // Y ya no puede pedir "para mi líder".
    expect((await get(member.headers, '/prayer-requests/context')).body).toEqual({
      leaders: [],
      pastoral: false,
    });
    const res = await send(member.headers, 'post', '/prayer-requests', { body: 'x', visibility: 'leader' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRAYER_NO_LEADER');
  });

  it('contexto: nombra a sus líderes; quien no tiene célula no tiene a quién', async () => {
    const { leader, member, outsider, pastor } = await setup();
    expect((await get(member.headers, '/prayer-requests/context')).body).toEqual({
      leaders: [`${leader.user.firstName} ${leader.user.lastName}`],
      pastoral: false,
    });
    // El líder es integrante de su propia célula: no se tiene a sí mismo como líder.
    expect((await get(leader.headers, '/prayer-requests/context')).body.leaders).toEqual([]);
    expect((await get(outsider.headers, '/prayer-requests/context')).body.leaders).toEqual([]);
    expect((await get(pastor.headers, '/prayer-requests/context')).body.pastoral).toBe(true);
  });

  it('anónima: los demás no ven el nombre, los pastores sí; solo aplica a las públicas', async () => {
    const { member, outsider, pastor } = await setup();
    const res = await send(member.headers, 'post', '/prayer-requests', {
      body: 'salud',
      visibility: 'public',
      anonymous: true,
    });
    expect(res.body.author).not.toBeNull();
    expect((await get(outsider.headers, `/prayer-requests/${res.body.id}`)).body.author).toBeNull();
    expect((await get(pastor.headers, `/prayer-requests/${res.body.id}`)).body.author.id).toBe(
      member.user.id,
    );

    const leaderOne = await send(member.headers, 'post', '/prayer-requests', {
      body: 'x',
      visibility: 'leader',
      anonymous: true,
    });
    expect(leaderOne.body.anonymous).toBe(false);
  });

  it('estoy orando: idempotente, cuenta personas y avisa al autor una sola vez', async () => {
    const { member, outsider } = await setup();
    const { id } = (
      await send(member.headers, 'post', '/prayer-requests', { body: 'b', visibility: 'public' })
    ).body;
    const pray = () => send(outsider.headers, 'put', `/prayer-requests/${id}/praying`);
    expect((await pray()).body).toEqual({ prayerCount: 1, praying: true });
    expect((await pray()).body).toEqual({ prayerCount: 1, praying: true });
    expect((await send(member.headers, 'put', `/prayer-requests/${id}/praying`)).body.prayerCount).toBe(2);
    expect((await get(member.headers, `/prayer-requests/${id}`)).body).toMatchObject({
      prayerCount: 2,
      praying: true,
    });
    expect((await send(outsider.headers, 'delete', `/prayer-requests/${id}/praying`)).body).toEqual({
      prayerCount: 1,
      praying: false,
    });
    await pray();
    const notices = await prisma.notification.findMany({ where: { type: 'prayer.praying' } });
    expect(notices).toHaveLength(1); // ni al orar por la propia ni al volver a marcar
    expect(notices[0]!.userId).toBe(member.user.id);
    expect(JSON.parse(notices[0]!.params ?? '{}').person).toBeTruthy();
  });

  it('respondida: solo el autor la marca, con testimonio; se puede reabrir', async () => {
    const { member, outsider } = await setup();
    const { id } = (
      await send(member.headers, 'post', '/prayer-requests', { body: 'b', visibility: 'public' })
    ).body;
    const other = await send(outsider.headers, 'patch', `/prayer-requests/${id}`, { status: 'answered' });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('PRAYER_NOT_AUTHOR');

    const answered = await send(member.headers, 'patch', `/prayer-requests/${id}`, {
      status: 'answered',
      testimony: '¡Conseguí trabajo!',
    });
    expect(answered.body).toMatchObject({ status: 'answered', testimony: '¡Conseguí trabajo!' });
    expect(answered.body.answeredAt).toBeTruthy();
    expect(await bodies(outsider.headers)).toEqual([]);
    expect(await bodies(outsider.headers, 'answered')).toEqual(['b']);

    const reopened = await send(member.headers, 'patch', `/prayer-requests/${id}`, { status: 'open' });
    expect(reopened.body).toMatchObject({ status: 'open', testimony: null, answeredAt: null });
  });

  it('cambiar a "para mi líder" le avisa al líder; borrar: el autor o los pastores', async () => {
    const { leader, member, outsider, pastor } = await setup();
    const { id } = (
      await send(member.headers, 'post', '/prayer-requests', { body: 'b', visibility: 'public' })
    ).body;
    await send(member.headers, 'patch', `/prayer-requests/${id}`, { visibility: 'leader' });
    expect(await prisma.notification.count({ where: { userId: leader.user.id } })).toBe(1);
    await send(member.headers, 'patch', `/prayer-requests/${id}`, { visibility: 'public' });
    await send(member.headers, 'patch', `/prayer-requests/${id}`, { visibility: 'leader' });
    expect(await prisma.notification.count({ where: { userId: leader.user.id } })).toBe(1);

    await send(member.headers, 'patch', `/prayer-requests/${id}`, { visibility: 'public' });
    expect((await send(outsider.headers, 'delete', `/prayer-requests/${id}`)).status).toBe(403);
    expect((await send(pastor.headers, 'delete', `/prayer-requests/${id}`)).status).toBe(204);
    expect(await bodies(member.headers, 'mine')).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'prayer.delete', entityId: String(id) } })).toBe(1);
  });

  it('no se ven peticiones de otra iglesia', async () => {
    const { member } = await setup();
    const { id } = (
      await send(member.headers, 'post', '/prayer-requests', { body: 'b', visibility: 'public' })
    ).body;
    const other = await provisionChurch();
    expect((await get(other.headers, `/prayer-requests/${id}`)).status).toBe(404);
    expect(await bodies(other.headers)).toEqual([]);
    expect((await send(other.headers, 'put', `/prayer-requests/${id}/praying`)).status).toBe(404);
  });
});
