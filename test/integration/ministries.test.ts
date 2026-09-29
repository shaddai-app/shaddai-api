import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const code = (res: request.Response) => res.body.error?.code;

async function send(
  headers: Headers,
  method: 'post' | 'patch' | 'put' | 'delete',
  url: string,
  body?: object,
) {
  return request(app)[method](api(url)).set(headers).send(body);
}
async function person(headers: Headers, firstName: string) {
  const res = await send(headers, 'post', '/people', { firstName, lastName: 'Test', allowDuplicate: true });
  if (res.status !== 201) throw new Error(`persona: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

/** Usuario con los permisos del rol «Líder de ministerio» (alcance propio), vinculado a una ficha. */
async function ministryLeader(accountId: number, personId: number) {
  const u = await actor(
    { 'ministerios.ver': 'own', 'ministerios.gestionar': 'own', 'ministerios.turnos': 'own' },
    accountId,
  );
  await prisma.user.update({ where: { id: u.user.id }, data: { personId } });
  return u;
}

describe('ministerios', () => {
  it('alta con puestos por tipo y líder, integrantes, puestos y borrado lógico', async () => {
    const c = await provisionChurch();
    const ana = await person(c.headers, 'Ana');
    const beto = await person(c.headers, 'Beto');

    const created = await send(c.headers, 'post', '/ministries', {
      name: 'Alabanza',
      kind: 'worship',
      color: 'grape',
      leaderPersonId: ana,
    });
    expect(created.status).toBe(201);
    const m = created.body;
    expect(m).toMatchObject({ name: 'Alabanza', kind: 'worship', canManage: true, canManageLeaders: true });
    expect(m.roles.map((r: { name: string }) => r.name)).toEqual([
      'Dirección',
      'Voz',
      'Coros',
      'Guitarra acústica',
      'Guitarra eléctrica',
      'Bajo',
      'Batería',
      'Teclado',
    ]);
    expect(m.members).toMatchObject([{ role: 'leader', person: { id: ana } }]);

    // Sin puestos por defecto.
    const plain = await send(c.headers, 'post', '/ministries', { name: 'Oración', withDefaultRoles: false });
    expect(plain.body).toMatchObject({ kind: 'general', roles: [] });

    // Integrantes: una sola integración activa por persona.
    let res = await send(c.headers, 'post', `/ministries/${m.id}/members`, { personId: beto });
    expect(res.status).toBe(201);
    expect(code(await send(c.headers, 'post', `/ministries/${m.id}/members`, { personId: beto }))).toBe(
      'MINISTRY_MEMBER_EXISTS',
    );
    const betoMember = res.body.members.find((x: { person: { id: number } }) => x.person.id === beto);
    res = await send(c.headers, 'patch', `/ministries/${m.id}/members/${betoMember.id}`, {
      role: 'coleader',
    });
    expect(res.body.members.map((x: { role: string }) => x.role)).toEqual(['leader', 'coleader']);

    // Puestos: alta, orden, desactivar y borrar.
    res = await send(c.headers, 'post', `/ministries/${m.id}/service-roles`, { name: 'Saxo' });
    const roles = res.body.roles as { id: number; name: string }[];
    expect(roles.at(-1)!.name).toBe('Saxo');
    const reversed = roles.map((r) => r.id).reverse();
    res = await send(c.headers, 'put', `/ministries/${m.id}/service-roles/order`, { ids: reversed });
    expect(res.body.roles[0].name).toBe('Saxo');
    expect(
      code(
        await send(c.headers, 'put', `/ministries/${m.id}/service-roles/order`, { ids: reversed.slice(1) }),
      ),
    ).toBe('SERVICE_ROLE_ORDER_INVALID');
    res = await send(c.headers, 'patch', `/ministries/${m.id}/service-roles/${reversed[0]}`, {
      isActive: false,
    });
    expect(res.body.roles[0]).toMatchObject({ name: 'Saxo', isActive: false });
    res = await send(c.headers, 'delete', `/ministries/${m.id}/service-roles/${reversed[0]}`);
    expect(res.body.roles).toHaveLength(8);

    // Salida: queda el historial (leftAt) y deja de figurar.
    res = await send(c.headers, 'delete', `/ministries/${m.id}/members/${betoMember.id}`);
    expect(res.body.members).toHaveLength(1);
    expect(await prisma.ministryMember.count({ where: { personId: beto, leftAt: { not: null } } })).toBe(1);

    let list = await request(app).get(api('/ministries')).set(c.headers);
    expect(list.body).toMatchObject({ canCreate: true });
    expect(list.body.items.map((x: { name: string }) => x.name)).toEqual(['Alabanza', 'Oración']);
    expect(list.body.items[0]).toMatchObject({ memberCount: 1, leaders: [{ id: ana, role: 'leader' }] });

    await send(c.headers, 'patch', `/ministries/${plain.body.id}`, { isActive: false });
    list = await request(app).get(api('/ministries')).set(c.headers);
    expect(list.body.items).toHaveLength(1);
    list = await request(app).get(api('/ministries?includeInactive=true')).set(c.headers);
    expect(list.body.items).toHaveLength(2);

    expect((await send(c.headers, 'delete', `/ministries/${m.id}`)).status).toBe(204);
    expect(
      (
        await request(app)
          .get(api(`/ministries/${m.id}`))
          .set(c.headers)
      ).status,
    ).toBe(404);
    expect(await prisma.ministry.count({ where: { id: m.id, deletedAt: { not: null } } })).toBe(1);
  });

  it('un líder con alcance propio gestiona su ministerio pero no nombra líderes ni crea', async () => {
    const c = await provisionChurch();
    const ana = await person(c.headers, 'Ana');
    const beto = await person(c.headers, 'Beto');
    const caro = await person(c.headers, 'Caro');
    const mine = (
      await send(c.headers, 'post', '/ministries', { name: 'Técnica', kind: 'tech', leaderPersonId: ana })
    ).body;
    const other = (await send(c.headers, 'post', '/ministries', { name: 'Ujieres', kind: 'ushers' })).body;
    const leader = await ministryLeader(c.accountId, ana);

    const list = await request(app).get(api('/ministries')).set(leader.headers);
    expect(list.body).toMatchObject({ canCreate: false, items: [{ id: mine.id }] });
    expect(
      (
        await request(app)
          .get(api(`/ministries/${other.id}`))
          .set(leader.headers)
      ).status,
    ).toBe(404);

    const detail = await request(app)
      .get(api(`/ministries/${mine.id}`))
      .set(leader.headers);
    expect(detail.body).toMatchObject({ canManage: true, canManageLeaders: false, canDelete: false });

    let res = await send(leader.headers, 'post', `/ministries/${mine.id}/members`, { personId: beto });
    expect(res.status).toBe(201);
    expect(
      code(
        await send(leader.headers, 'post', `/ministries/${mine.id}/members`, {
          personId: caro,
          role: 'leader',
        }),
      ),
    ).toBe('MINISTRY_LEADER_FORBIDDEN');
    const anaMember = res.body.members.find((x: { role: string }) => x.role === 'leader');
    expect(code(await send(leader.headers, 'delete', `/ministries/${mine.id}/members/${anaMember.id}`))).toBe(
      'MINISTRY_LEADER_FORBIDDEN',
    );
    res = await send(leader.headers, 'post', `/ministries/${mine.id}/service-roles`, { name: 'Cámara' });
    expect(res.status).toBe(201);

    expect(code(await send(leader.headers, 'post', '/ministries', { name: 'Nuevo' }))).toBe(
      'MINISTRY_CREATE_FORBIDDEN',
    );
    expect(code(await send(leader.headers, 'delete', `/ministries/${mine.id}`))).toBe(
      'MINISTRY_DELETE_FORBIDDEN',
    );
    expect(code(await send(leader.headers, 'patch', `/ministries/${other.id}`, { name: 'X' }))).toBe(
      'MINISTRY_NOT_FOUND',
    );

    // Un integrante (servidor) con ver propio ve su ministerio pero no lo gestiona.
    const servant = await ministryLeader(c.accountId, beto);
    expect(
      (
        await request(app)
          .get(api(`/ministries/${mine.id}`))
          .set(servant.headers)
      ).body.canManage,
    ).toBe(false);
    expect(
      code(await send(servant.headers, 'post', `/ministries/${mine.id}/service-roles`, { name: 'X' })),
    ).toBe('MINISTRY_MANAGE_FORBIDDEN');
  });

  it('valida personas y sedes de la cuenta y aísla entre iglesias', async () => {
    const a = await provisionChurch();
    const b = await provisionChurch();
    const foreign = await person(b.headers, 'Ajeno');
    expect(code(await send(a.headers, 'post', '/ministries', { name: 'X', leaderPersonId: foreign }))).toBe(
      'PERSON_INVALID',
    );
    const m = (await send(a.headers, 'post', '/ministries', { name: 'Niños', kind: 'kids' })).body;
    expect(code(await send(a.headers, 'post', `/ministries/${m.id}/members`, { personId: foreign }))).toBe(
      'PERSON_INVALID',
    );
    expect(code(await send(a.headers, 'patch', `/ministries/${m.id}`, { campusId: 999999 }))).toBe(
      'CAMPUS_INVALID',
    );
    expect(
      (
        await request(app)
          .get(api(`/ministries/${m.id}`))
          .set(b.headers)
      ).status,
    ).toBe(404);
    const nobody = await actor({ 'eventos.ver': 'all' }, a.accountId);
    expect((await request(app).get(api('/ministries')).set(nobody.headers)).status).toBe(403);
  });
});
