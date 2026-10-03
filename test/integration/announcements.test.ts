import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { publishDueAnnouncements } from '../../src/modules/announcements/announcements.service.js';
import { actor, app, grantRole, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const get = (h: Headers, path: string) => request(app).get(api(path)).set(h);
const send = (h: Headers, method: 'post' | 'patch' | 'delete', path: string, body?: object) =>
  request(app)[method](api(path)).set(h).send(body);
const titles = async (h: Headers) =>
  ((await get(h, '/announcements')).body.items as { title: string }[]).map((a) => a.title);
const day = 86_400_000;

async function setup() {
  const church = await provisionChurch();
  const manager = await actor({ 'anuncios.gestionar': 'all' }, church.accountId);
  const member = await actor({}, church.accountId);
  return { church, manager, member };
}

/** Le da al usuario una ficha de persona (para audiencias por ministerio o sede). */
async function withPerson(user: { id: number }, accountId: number, data: { campusId?: number } = {}) {
  const status = await prisma.catalogItem.findFirstOrThrow({ where: { accountId, type: 'person_status' } });
  const person = await prisma.person.create({
    data: {
      accountId,
      statusId: status.id,
      firstName: 'Ana',
      lastName: 'Prueba',
      searchText: 'ana prueba',
      ...data,
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { personId: person.id } });
  return person;
}

describe('anuncios', () => {
  it('para todos: lo ven todos, fijados primero, y avisa a todos menos al autor', async () => {
    const { manager, member } = await setup();
    await send(manager.headers, 'post', '/announcements', { title: 'Viejo', body: 'b', notify: false });
    const res = await send(manager.headers, 'post', '/announcements', {
      title: 'Retiro',
      body: 'Inscripciones abiertas',
      pinned: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.author.name).toBeTruthy();
    expect(await titles(member.headers)).toEqual(['Retiro', 'Viejo']);

    const notices = await prisma.notification.findMany({ where: { type: 'announcement.published' } });
    expect(notices.map((n) => n.userId).sort()).not.toContain(manager.user.id);
    expect(notices.some((n) => n.userId === member.user.id)).toBe(true);
    expect(JSON.parse(notices[0]!.params ?? '{}')).toMatchObject({ title: 'Retiro' });
    expect(notices[0]!.link).toBe(`/anuncios/${res.body.id}`);
    // "Viejo" no pidió aviso.
    expect(notices.every((n) => JSON.parse(n.params ?? '{}').title === 'Retiro')).toBe(true);
  });

  it('por rol, ministerio y sede: solo lo ve quien está en la audiencia', async () => {
    const { church, manager, member } = await setup();
    const db = prisma;
    const deacons = await grantRole(member.user, { 'personas.ver': 'all' });
    const campus = await db.campus.create({ data: { accountId: church.accountId, name: 'Sede Norte' } });
    const ministry = await db.ministry.create({ data: { accountId: church.accountId, name: 'Alabanza' } });

    const inMinistry = await actor({}, church.accountId);
    const p1 = await withPerson(inMinistry.user, church.accountId);
    await db.ministryMember.create({
      data: { accountId: church.accountId, ministryId: ministry.id, personId: p1.id, joinedAt: new Date() },
    });
    const leftMinistry = await actor({}, church.accountId);
    const p2 = await withPerson(leftMinistry.user, church.accountId);
    await db.ministryMember.create({
      data: {
        accountId: church.accountId,
        ministryId: ministry.id,
        personId: p2.id,
        joinedAt: new Date(Date.now() - 30 * day),
        leftAt: new Date(),
      },
    });
    const north = await actor({}, church.accountId);
    await withPerson(north.user, church.accountId, { campusId: campus.id });

    const post = (title: string, kind: string, refId: number) =>
      send(manager.headers, 'post', '/announcements', { title, body: 'b', audiences: [{ kind, refId }] });
    expect((await post('Rol', 'role', deacons.id)).status).toBe(201);
    expect((await post('Ministerio', 'ministry', ministry.id)).status).toBe(201);
    expect((await post('Sede', 'campus', campus.id)).status).toBe(201);

    expect(await titles(member.headers)).toEqual(['Rol']);
    expect(await titles(inMinistry.headers)).toEqual(['Ministerio']);
    expect(await titles(leftMinistry.headers)).toEqual([]);
    expect(await titles(north.headers)).toEqual(['Sede']);
    // Aviso solo a la audiencia.
    const notified = await prisma.notification.findMany({
      where: { type: 'announcement.published' },
      select: { userId: true, params: true },
    });
    const forMinistry = notified
      .filter((n) => JSON.parse(n.params ?? '{}').title === 'Ministerio')
      .map((n) => n.userId);
    expect(forMinistry).toEqual([inMinistry.user.id]);
    // Quien gestiona igual puede abrir uno que no es para él.
    const ministryId = (await get(manager.headers, '/announcements/manage')).body.items.find(
      (a: { title: string }) => a.title === 'Ministerio',
    ).id;
    expect((await get(manager.headers, `/announcements/${ministryId}`)).status).toBe(200);
    expect((await get(member.headers, `/announcements/${ministryId}`)).status).toBe(404);
  });

  it('programado: no se ve ni avisa hasta su fecha; el programador avisa una sola vez', async () => {
    const { church, manager, member } = await setup();
    const res = await send(manager.headers, 'post', '/announcements', {
      title: 'Cena',
      body: 'b',
      publishAt: new Date(Date.now() + 2 * day).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(await titles(member.headers)).toEqual([]);
    expect(await prisma.notification.count()).toBe(0);
    expect((await get(manager.headers, '/announcements/manage?status=scheduled')).body.items).toHaveLength(1);

    expect(await publishDueAnnouncements(church.accountId)).toBe(0); // todavía no
    await prisma.announcement.update({
      where: { id: res.body.id },
      data: { publishAt: new Date(Date.now() - 1000) },
    });
    expect(await publishDueAnnouncements(church.accountId)).toBeGreaterThan(0);
    expect(await publishDueAnnouncements(church.accountId)).toBe(0);
    expect(await titles(member.headers)).toEqual(['Cena']);
    expect(await prisma.notification.count({ where: { userId: member.user.id } })).toBe(1);
  });

  it('vencido: sale del inicio y queda en la lista de vencidos', async () => {
    const { manager, member } = await setup();
    const res = await send(manager.headers, 'post', '/announcements', {
      title: 'Corto',
      body: 'b',
      publishAt: new Date(Date.now() - 2 * day).toISOString(),
      expiresAt: new Date(Date.now() + day).toISOString(),
    });
    await prisma.announcement.update({
      where: { id: res.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await titles(member.headers)).toEqual([]);
    expect((await get(manager.headers, '/announcements/manage?status=expired')).body.items).toHaveLength(1);
    expect((await get(manager.headers, '/announcements/manage')).body.items).toHaveLength(0);
  });

  it('editar, borrar y validaciones', async () => {
    const { manager, member } = await setup();
    const other = await provisionChurch();
    const foreignRole = other.roleId('pastor');
    const create = (body: object) =>
      send(manager.headers, 'post', '/announcements', { title: 't', body: 'b', ...body });

    expect((await create({ audiences: [{ kind: 'role', refId: foreignRole }] })).body.error.code).toBe(
      'ANNOUNCEMENT_AUDIENCE_INVALID',
    );
    expect(
      (
        await create({
          publishAt: new Date(Date.now() + day).toISOString(),
          expiresAt: new Date().toISOString(),
        })
      ).body.error.code,
    ).toBe('ANNOUNCEMENT_EXPIRES_BEFORE_PUBLISH');
    expect((await send(member.headers, 'post', '/announcements', { title: 't', body: 'b' })).status).toBe(
      403,
    );

    const a = await create({ notify: false });
    const edited = await send(manager.headers, 'patch', `/announcements/${a.body.id}`, {
      title: 'Editado',
      pinned: true,
    });
    expect(edited.body).toMatchObject({ title: 'Editado', pinned: true });
    expect(await titles(member.headers)).toEqual(['Editado']);

    expect((await send(manager.headers, 'delete', `/announcements/${a.body.id}`)).status).toBe(204);
    expect(await titles(member.headers)).toEqual([]);
    expect((await send(manager.headers, 'delete', `/announcements/${a.body.id}`)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { entity: 'Announcement' } })).toBe(3);
  });

  it('opciones de audiencia: roles, ministerios y sedes de la iglesia', async () => {
    const { church, manager } = await setup();
    await prisma.ministry.create({ data: { accountId: church.accountId, name: 'Ujieres' } });
    const res = await get(manager.headers, '/announcements/audience-options');
    expect(res.body.roles.length).toBeGreaterThan(3);
    expect(res.body.ministries.map((m: { name: string }) => m.name)).toEqual(['Ujieres']);
    expect(res.body.campuses).toHaveLength(1);
  });
});
