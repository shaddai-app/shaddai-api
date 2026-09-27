import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

async function person(headers: Headers, firstName: string, lastName = 'Test') {
  const res = await request(app)
    .post(api('/people'))
    .set(headers)
    .send({ firstName, lastName, allowDuplicate: true });
  if (res.status !== 201) throw new Error(`persona: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

async function post(headers: Headers, path: string, body: object) {
  const res = await request(app).post(api(path)).set(headers).send(body);
  if (res.status !== 201) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const cellBody = (zoneId: number, leaderPersonId: number, extra: object = {}) => ({
  name: 'Célula',
  zoneId,
  meetingDay: 3,
  meetingTime: '20:00',
  address: 'Mitre 123',
  neighborhood: 'Centro',
  city: 'Quilmes',
  lat: -34.7206,
  lng: -58.2546,
  leaderPersonId,
  ...extra,
});

/** Iglesia con una red, dos zonas y una célula por zona; devuelve ids útiles. */
async function church() {
  const c = await provisionChurch();
  const supervisor = await person(c.headers, 'Sara', 'Supervisora');
  const network = await post(c.headers, '/networks', { name: 'Red Jóvenes', color: 'grape' });
  const zoneA = await post(c.headers, '/zones', {
    name: 'Zona A',
    networkId: network.id,
    supervisorPersonId: supervisor,
  });
  const zoneB = await post(c.headers, '/zones', { name: 'Zona B', networkId: network.id });
  const leaderA = await person(c.headers, 'Luis', 'LíderA');
  const leaderB = await person(c.headers, 'Lara', 'LíderB');
  const cellA = await post(c.headers, '/cells', cellBody(zoneA.id, leaderA, { name: 'Célula Norte' }));
  const cellB = await post(
    c.headers,
    '/cells',
    cellBody(zoneB.id, leaderB, { name: 'Célula Sur', lat: -34.8, lng: -58.4, neighborhood: 'Bernal' }),
  );
  return { ...c, network, zoneA, zoneB, supervisor, leaderA, leaderB, cellA, cellB };
}

/** Usuario con los permisos del rol «Líder de célula», vinculado a una ficha. */
async function leaderUser(accountId: number, personId: number) {
  const u = await actor(
    {
      'personas.ver': 'own',
      'personas.editar': 'own',
      'celulas.ver': 'own',
      'celulas.editar': 'own',
      'celulas.ver_direccion': 'own',
      'celulas.reportar': 'own',
    },
    accountId,
  );
  await prisma.user.update({ where: { id: u.user.id }, data: { personId } });
  return u;
}

describe('redes y zonas', () => {
  it('no se borran con hijos; los listados muestran conteos', async () => {
    const c = await church();
    const networks = await request(app).get(api('/networks')).set(c.headers);
    expect(networks.body.items).toMatchObject([{ name: 'Red Jóvenes', zoneCount: 2 }]);
    const zones = await request(app)
      .get(api(`/zones?networkId=${c.network.id}`))
      .set(c.headers);
    expect(zones.body.items.map((z: { name: string; cellCount: number }) => [z.name, z.cellCount])).toEqual([
      ['Zona A', 1],
      ['Zona B', 1],
    ]);
    expect(
      (
        await request(app)
          .delete(api(`/networks/${c.network.id}`))
          .set(c.headers)
      ).body.error.code,
    ).toBe('NETWORK_HAS_ZONES');
    expect(
      (
        await request(app)
          .delete(api(`/zones/${c.zoneA.id}`))
          .set(c.headers)
      ).body.error.code,
    ).toBe('ZONE_HAS_CELLS');
    const empty = await post(c.headers, '/zones', { name: 'Vacía', networkId: c.network.id });
    expect(
      (
        await request(app)
          .delete(api(`/zones/${empty.id}`))
          .set(c.headers)
      ).status,
    ).toBe(204);
  });

  it('no acepta red o supervisor de otra cuenta', async () => {
    const a = await church();
    const b = await provisionChurch();
    const foreignPerson = await person(b.headers, 'Ajena');
    const res = await request(app)
      .post(api('/zones'))
      .set(a.headers)
      .send({ name: 'X', networkId: a.network.id, supervisorPersonId: foreignPerson });
    expect(res.body.error.code).toBe('PERSON_INVALID');
    const otherNetwork = await request(app)
      .post(api('/zones'))
      .set(b.headers)
      .send({ name: 'X', networkId: a.network.id });
    expect(otherNetwork.body.error.code).toBe('NETWORK_INVALID');
  });
});

describe('células', () => {
  it('alta con el líder como integrante; detalle con acceso completo para el admin', async () => {
    const c = await church();
    const detail = await request(app)
      .get(api(`/cells/${c.cellA.id}`))
      .set(c.headers);
    expect(detail.body).toMatchObject({
      name: 'Célula Norte',
      status: 'active',
      address: 'Mitre 123',
      lat: -34.7206,
      memberCount: 1,
      leader: { id: c.leaderA },
      zone: { name: 'Zona A', network: { name: 'Red Jóvenes' } },
      access: { edit: true, address: true, report: true, multiply: true, close: true },
    });
    expect(detail.body.members.map((m: { id: number }) => m.id)).toEqual([c.leaderA]);

    const list = await request(app).get(api('/cells?q=norte')).set(c.headers);
    expect(list.body.items.map((x: { name: string }) => x.name)).toEqual(['Célula Norte']);
    const byLeader = await request(app).get(api('/cells?q=lidera')).set(c.headers);
    expect(byLeader.body.total).toBe(1);
  });

  it('líder con alcance propio: solo su célula, con dirección, y sus integrantes en personas', async () => {
    const c = await church();
    const member = await person(c.headers, 'Integrante', 'Norte');
    await post(c.headers, `/cells/${c.cellA.id}/members`, { personId: member });
    const leader = await leaderUser(c.accountId, c.leaderA);

    const list = await request(app).get(api('/cells')).set(leader.headers);
    expect(list.body.items.map((x: { id: number }) => x.id)).toEqual([c.cellA.id]);
    expect(list.body.items[0].address).toBe('Mitre 123');
    expect(
      (
        await request(app)
          .get(api(`/cells/${c.cellB.id}`))
          .set(leader.headers)
      ).status,
    ).toBe(404);
    const mine = await request(app).get(api('/cells?mine=true')).set(leader.headers);
    expect(mine.body.total).toBe(1);

    // Alcance "propio" de personas = integrantes de sus células (+ lo que cargó y su ficha).
    const people = await request(app).get(api('/people')).set(leader.headers);
    expect(people.body.items.map((p: { id: number }) => p.id).sort()).toEqual([c.leaderA, member].sort());
    expect(
      (
        await request(app)
          .get(api(`/people/${c.leaderB}`))
          .set(leader.headers)
      ).status,
    ).toBe(404);

    const edit = await request(app)
      .patch(api(`/cells/${c.cellA.id}`))
      .set(leader.headers)
      .send({ meetingTime: '19:30' });
    expect(edit.body.meetingTime).toBe('19:30');
    const other = await request(app)
      .patch(api(`/cells/${c.cellB.id}`))
      .set(leader.headers)
      .send({ name: 'x' });
    expect(other.status).toBe(404);
  });

  it('supervisor: ve las células de su zona y crea solo en zonas propias', async () => {
    const c = await church();
    const sup = await actor(
      { 'personas.ver': 'own', 'celulas.ver': 'own', 'celulas.crear': 'own', 'celulas.editar': 'own' },
      c.accountId,
    );
    await prisma.user.update({ where: { id: sup.user.id }, data: { personId: c.supervisor } });
    const list = await request(app).get(api('/cells')).set(sup.headers);
    expect(list.body.items.map((x: { id: number }) => x.id)).toEqual([c.cellA.id]);
    // Sin ver_direccion: sin calle ni coordenadas exactas.
    expect(list.body.items[0]).not.toHaveProperty('address');
    expect(list.body.items[0].neighborhood).toBe('Centro');

    const zones = await request(app).get(api('/zones')).set(sup.headers);
    expect(zones.body.items.map((z: { id: number }) => z.id)).toEqual([c.zoneA.id]);

    const created = await request(app)
      .post(api('/cells'))
      .set(sup.headers)
      .send(cellBody(c.zoneA.id, c.leaderA, { name: 'Nueva A' }));
    expect(created.status).toBe(201);
    const denied = await request(app)
      .post(api('/cells'))
      .set(sup.headers)
      .send(cellBody(c.zoneB.id, c.leaderA, { name: 'Nueva B' }));
    expect(denied.body.error.code).toBe('ZONE_INVALID');
  });

  it('mapa: puntos exactos con permiso de dirección, aproximados sin él', async () => {
    const c = await church();
    const exact = await request(app).get(api('/cells/map')).set(c.headers);
    expect(exact.body.items.find((x: { id: number }) => x.id === c.cellA.id)).toMatchObject({
      lat: -34.7206,
      approximate: false,
    });
    const viewer = await actor({ 'celulas.ver': 'all' }, c.accountId);
    const blurred = await request(app).get(api('/cells/map')).set(viewer.headers);
    expect(blurred.body.items.find((x: { id: number }) => x.id === c.cellA.id)).toMatchObject({
      lat: -34.72,
      lng: -58.25,
      approximate: true,
    });
    const addr = await request(app)
      .patch(api(`/cells/${c.cellA.id}`))
      .set(c.headers)
      .send({ address: 'Otra 1' });
    expect(addr.status).toBe(200);
  });

  it('célula más cercana a un punto', async () => {
    const c = await church();
    const res = await request(app).get(api('/cells/nearest?lat=-34.721&lng=-58.255')).set(c.headers);
    expect(res.body.items.map((x: { name: string }) => x.name)).toEqual(['Célula Norte', 'Célula Sur']);
    expect(res.body.items[0].distanceKm).toBeLessThan(1);
    expect(res.body.items[0]).not.toHaveProperty('address');
    expect((await request(app).get(api('/cells/nearest')).set(c.headers)).body.error.code).toBe(
      'LOCATION_REQUIRED',
    );
  });

  it('una persona en una sola célula: mover requiere confirmar; el líder no se puede quitar', async () => {
    const c = await church();
    const p = await person(c.headers, 'Viajera');
    await post(c.headers, `/cells/${c.cellA.id}/members`, { personId: p });
    const conflict = await request(app)
      .post(api(`/cells/${c.cellB.id}/members`))
      .set(c.headers)
      .send({ personId: p });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'PERSON_IN_OTHER_CELL',
      details: { cellId: c.cellA.id, cellName: 'Célula Norte' },
    });
    const moved = await request(app)
      .post(api(`/cells/${c.cellB.id}/members`))
      .set(c.headers)
      .send({ personId: p, move: true });
    expect(moved.body.memberCount).toBe(2);
    expect(await prisma.cellMember.count({ where: { personId: p, leftAt: null } })).toBe(1);

    const leaderOut = await request(app)
      .delete(api(`/cells/${c.cellA.id}/members/${c.leaderA}`))
      .set(c.headers);
    expect(leaderOut.body.error.code).toBe('CELL_LEADER_REQUIRED');
    const out = await request(app)
      .delete(api(`/cells/${c.cellB.id}/members/${p}`))
      .set(c.headers);
    expect(out.body.memberCount).toBe(1);
  });

  it('cerrar una célula da de baja a sus integrantes y la saca del listado', async () => {
    const c = await church();
    const closed = await request(app)
      .delete(api(`/cells/${c.cellB.id}`))
      .set(c.headers);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.closedAt).not.toBeNull();
    expect(await prisma.cellMember.count({ where: { cellId: c.cellB.id, leftAt: null } })).toBe(0);
    expect((await request(app).get(api('/cells')).set(c.headers)).body.total).toBe(1);
    expect((await request(app).get(api('/cells?status=closed')).set(c.headers)).body.total).toBe(1);
    const again = await request(app)
      .patch(api(`/cells/${c.cellB.id}`))
      .set(c.headers)
      .send({ name: 'x' });
    expect(again.body.error.code).toBe('CELL_CLOSED');
  });

  it('personas: no se da de baja a quien lidera; la fusión mueve el liderazgo', async () => {
    const c = await church();
    expect(
      (
        await request(app)
          .delete(api(`/people/${c.leaderA}`))
          .set(c.headers)
      ).body.error.code,
    ).toBe('PERSON_LEADS_CELL');
    const dup = await person(c.headers, 'Luis', 'LíderA');
    await request(app)
      .post(api(`/people/${c.leaderA}/merge`))
      .set(c.headers)
      .send({ intoId: dup });
    const cell = await prisma.cell.findUniqueOrThrow({ where: { id: c.cellA.id } });
    expect(cell.leaderPersonId).toBe(dup);
    expect(
      await prisma.cellMember.count({ where: { cellId: c.cellA.id, personId: dup, leftAt: null } }),
    ).toBe(1);
  });

  it('aislamiento: zona y célula de otra cuenta', async () => {
    const a = await church();
    const b = await provisionChurch();
    const leaderB = await person(b.headers, 'Otro');
    const res = await request(app).post(api('/cells')).set(b.headers).send(cellBody(a.zoneA.id, leaderB));
    expect(res.body.error.code).toBe('ZONE_INVALID');
    expect(
      (
        await request(app)
          .get(api(`/cells/${a.cellA.id}`))
          .set(b.headers)
      ).status,
    ).toBe(404);
    const foreignLeader = await request(app)
      .patch(api(`/cells/${a.cellA.id}`))
      .set(a.headers)
      .send({ leaderPersonId: leaderB });
    expect(foreignLeader.body.error.code).toBe('PERSON_INVALID');
  });

  it('geocodificación deshabilitada sin proveedor', async () => {
    const c = await church();
    expect((await request(app).get(api('/geocode/status')).set(c.headers)).body).toEqual({ enabled: false });
    const res = await request(app).post(api('/geocode')).set(c.headers).send({ q: 'Mitre 123, Quilmes' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('GEOCODING_DISABLED');
  });
});
