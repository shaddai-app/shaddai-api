import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { emailsSettled } from '../../src/modules/notifications/notifications.service.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const code = (res: request.Response) => res.body.error?.code;
const send = (headers: Headers, method: 'post' | 'patch' | 'delete', url: string, body?: object) =>
  request(app)[method](api(url)).set(headers).send(body);
const get = (headers: Headers, url: string) => request(app).get(api(url)).set(headers);
const today = () => todayIn('America/Argentina/Buenos_Aires');

async function person(headers: Headers, firstName: string) {
  const res = await send(headers, 'post', '/people', { firstName, lastName: 'Test', allowDuplicate: true });
  return res.body.id as number;
}

/**
 * Alabanza con Ana (servidora, con usuario) y Lía (líder, con usuario); el dueño de la iglesia
 * asigna los turnos.
 */
async function setup() {
  const c = await provisionChurch();
  const ana = await person(c.headers, 'Ana');
  const lia = await person(c.headers, 'Lía');
  const worship = (await send(c.headers, 'post', '/ministries', { name: 'Alabanza', kind: 'worship' })).body;
  await send(c.headers, 'post', `/ministries/${worship.id}/members`, { personId: ana });
  await send(c.headers, 'post', `/ministries/${worship.id}/members`, { personId: lia, role: 'leader' });
  const anaUser = await actor({}, c.accountId);
  await prisma.user.update({ where: { id: anaUser.user.id }, data: { personId: ana, locale: 'es' } });
  const liaUser = await actor({}, c.accountId);
  await prisma.user.update({ where: { id: liaUser.user.id }, data: { personId: lia, locale: 'en' } });
  const first = addDays(today(), 1);
  const event = (
    await send(c.headers, 'post', '/events', {
      type: 'service',
      title: 'Culto',
      startsAt: `${first}T10:00`,
      endsAt: `${first}T12:00`,
    })
  ).body;
  const voz = worship.roles.find((r: { name: string }) => r.name === 'Voz').id as number;
  const assign = () =>
    send(c.headers, 'post', `/ministries/${worship.id}/assignments`, {
      eventId: event.id,
      occurrence: `${first}T10:00`,
      serviceRoleId: voz,
      personId: ana,
    });
  return { c, ana, worship, anaUser, liaUser, first, assign };
}

describe('notificaciones', () => {
  it('turno asignado y rechazado: aviso en la app, mail y lectura', async () => {
    const { c, worship, anaUser, liaUser, first, assign } = await setup();
    memoryOutbox.length = 0;

    const assigned = await assign();
    expect(assigned.status).toBe(201);
    await emailsSettled();

    // Ana recibe el aviso en la app y por mail (en castellano).
    const inbox = (await get(anaUser.headers, '/notifications')).body;
    expect(inbox).toMatchObject({ total: 1, unread: 1 });
    expect(inbox.items[0]).toMatchObject({
      type: 'assignment.created',
      link: '/mis-turnos',
      readAt: null,
      params: { ministry: 'Alabanza', role: 'Voz', event: 'Culto', startsAt: `${first}T10:00` },
    });
    expect(memoryOutbox).toHaveLength(1);
    expect(memoryOutbox[0]).toMatchObject({ to: anaUser.user.email, subject: 'Te asignaron: Voz en Culto' });
    expect(memoryOutbox[0]!.text).toContain('/mis-turnos');
    expect((await get(anaUser.headers, '/notifications/unread-count')).body).toEqual({ count: 1 });
    const stored = await prisma.notification.findFirstOrThrow({ where: { userId: anaUser.user.id } });
    expect(stored.emailedAt).not.toBeNull();

    // Nadie más se entera; el dueño (que asignó) no se avisa a sí mismo.
    expect((await get(liaUser.headers, '/notifications')).body.total).toBe(0);
    expect((await get(c.headers, '/notifications')).body.total).toBe(0);

    // Ana rechaza: avisan al dueño (asignó) y a Lía (líder), Lía en inglés.
    memoryOutbox.length = 0;
    const mine = (await get(anaUser.headers, '/me/assignments')).body.items[0];
    await send(anaUser.headers, 'post', `/me/assignments/${mine.id}/respond`, {
      response: 'decline',
      reason: 'Estoy de viaje',
    });
    await emailsSettled();
    const liaInbox = (await get(liaUser.headers, '/notifications')).body;
    expect(liaInbox.items[0]).toMatchObject({
      type: 'assignment.declined',
      link: `/ministerios/${worship.id}/turnos?desde=${first}`,
      params: { person: 'Ana Test', reason: 'Estoy de viaje', role: 'Voz' },
    });
    expect((await get(c.headers, '/notifications')).body.total).toBe(1);
    expect((await get(anaUser.headers, '/notifications')).body.total).toBe(1); // solo el suyo
    expect(memoryOutbox).toHaveLength(2);
    const toLia = memoryOutbox.find((m) => m.to === liaUser.user.email)!;
    expect(toLia.subject).toMatch(/^Ana Test can’t serve on /);
    expect(toLia.text).toContain('Reason: Estoy de viaje');

    // Lectura: uno, y todos.
    const id = inbox.items[0].id;
    expect((await send(anaUser.headers, 'post', `/notifications/${id}/read`)).body).toEqual({ count: 0 });
    expect((await get(anaUser.headers, '/notifications?unread=true')).body.total).toBe(0);
    expect((await get(anaUser.headers, '/notifications')).body.items[0].readAt).not.toBeNull();
    // Un aviso ajeno no se puede marcar.
    expect(code(await send(liaUser.headers, 'post', `/notifications/${id}/read`))).toBe(
      'NOTIFICATION_NOT_FOUND',
    );
    expect((await send(liaUser.headers, 'post', '/notifications/read-all')).body).toEqual({ count: 0 });
    expect((await get(liaUser.headers, '/notifications/unread-count')).body).toEqual({ count: 0 });
  });

  it('preferencias: sin mail, sin aviso en la app, y otra iglesia', async () => {
    const { anaUser, assign, c } = await setup();

    const defaults = (await get(anaUser.headers, '/me/notification-prefs')).body.items;
    expect(defaults).toEqual(
      expect.arrayContaining([
        { type: 'assignment.created', inApp: true, email: true },
        { type: 'assignment.declined', inApp: true, email: true },
      ]),
    );
    expect(
      code(
        await send(anaUser.headers, 'patch', '/me/notification-prefs', {
          prefs: [{ type: 'nope', email: false }],
        }),
      ),
    ).toBe('VALIDATION_ERROR');

    // Sin mail: el aviso llega solo a la app.
    const saved = await send(anaUser.headers, 'patch', '/me/notification-prefs', {
      prefs: [{ type: 'assignment.created', email: false }],
    });
    expect(saved.body.items).toContainEqual({ type: 'assignment.created', inApp: true, email: false });
    memoryOutbox.length = 0;
    await assign();
    await emailsSettled();
    expect(memoryOutbox).toHaveLength(0);
    expect((await get(anaUser.headers, '/notifications')).body.total).toBe(1);

    // Sin aviso en la app pero con mail: no queda en el centro, sí llega el mail.
    await prisma.serviceAssignment.deleteMany();
    await send(anaUser.headers, 'patch', '/me/notification-prefs', {
      prefs: [{ type: 'assignment.created', inApp: false, email: true }],
    });
    await assign();
    await emailsSettled();
    expect(memoryOutbox).toHaveLength(1);
    expect((await get(anaUser.headers, '/notifications')).body.total).toBe(1); // sigue el anterior

    // Un usuario inactivo no recibe nada.
    await prisma.serviceAssignment.deleteMany();
    await send(anaUser.headers, 'patch', '/me/notification-prefs', {
      prefs: [{ type: 'assignment.created', inApp: true }],
    });
    await prisma.user.update({ where: { id: anaUser.user.id }, data: { isActive: false } });
    memoryOutbox.length = 0;
    await assign();
    await emailsSettled();
    expect(memoryOutbox).toHaveLength(0);
    // Una fila visible (la del principio) y otra oculta: el registro del mail sin aviso en la app.
    expect(await prisma.notification.count({ where: { userId: anaUser.user.id, inApp: true } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: anaUser.user.id } })).toBe(2);

    // Otra iglesia no ve ni marca avisos ajenos.
    const other = await provisionChurch();
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: anaUser.user.id } });
    expect(code(await send(other.headers, 'post', `/notifications/${notification.id}/read`))).toBe(
      'NOTIFICATION_NOT_FOUND',
    );
    expect((await get(other.headers, '/notifications')).body.total).toBe(0);
    expect((await get(c.headers, '/notifications')).body.total).toBe(0);
  });
});
