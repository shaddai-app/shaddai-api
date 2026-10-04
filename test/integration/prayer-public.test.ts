import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { exportRows } from '../../src/core/db/account-data.js';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import { emailsSettled } from '../../src/modules/notifications/notifications.service.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(async () => {
  await resetDb();
  memoryOutbox.length = 0;
});
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const get = (h: Headers, path: string) => request(app).get(api(path)).set(h);
const send = (h: Headers, method: 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) =>
  request(app)[method](api(path)).set(h).send(body);

const BODY = 'Por la salud de mi papá, que está internado.';
const form = {
  body: BODY,
  name: 'Ana Gómez',
  phone: '11 5555-0101',
  email: 'ana@visita.test',
  wantsContact: true,
  wallShare: 'named',
  consent: true,
  locale: 'es',
};

async function setup() {
  const church = await provisionChurch();
  const { slug } = await prisma.account.findUniqueOrThrow({ where: { id: church.accountId } });
  const pastor = await actor({ 'oracion.pastoral': 'all' }, church.accountId);
  const member = await actor({}, church.accountId);
  return { church, slug, pastor, member };
}

/** Manda el formulario y devuelve el token y el id de la petición creada. */
async function submit(slug: string, body: object = form) {
  const res = await request(app)
    .post(api(`/public/${slug}/prayer`))
    .send(body);
  expect(res.status).toBe(201);
  const row = await prisma.prayerRequest.findFirstOrThrow({ orderBy: { id: 'desc' } });
  return { token: res.body.token as string, id: row.id };
}

const link = (slug: string, token: string) => api(`/public/${slug}/prayer/${token}`);

describe('pedidos de oración desde el formulario público', () => {
  it('crea la petición para los pastores, avisa sin el texto y le manda el enlace a quien pidió', async () => {
    const { church, slug, pastor, member } = await setup();

    const config = await request(app).get(api(`/public/${slug}/prayer-form`));
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({ church: { slug }, consentVersion: '2026-09' });

    const { token, id } = await submit(slug);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await prisma.prayerRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      source: 'form',
      visibility: 'pastors',
      createdById: null,
      requesterName: 'Ana Gómez',
      requesterPhone: '1155550101',
      wantsContact: true,
      wallShare: 'named',
      consentVersion: '2026-09',
    });
    // Solo el hash y el token cifrado: el token no queda en la base.
    expect(row.accessTokenHash).toHaveLength(64);
    expect(row.accessTokenEnc).not.toContain(token);

    // Aviso a quien tiene oracion.pastoral (el pastor y el dueño), no al miembro.
    const notices = await prisma.notification.findMany({ where: { type: 'prayer.public' } });
    expect(notices.map((n) => n.userId).sort()).toEqual([pastor.user.id, church.ownerId].sort());
    expect(notices[0]!.params).not.toContain('papá');
    expect(JSON.parse(notices[0]!.params!)).toEqual({ name: 'Ana Gómez', wantsContact: 1 });

    // Mail con el enlace, sin el texto de la petición.
    await emailsSettled();
    const mail = memoryOutbox.find((m) => m.to === 'ana@visita.test')!;
    expect(mail.text).toContain(`/orar/${slug}/${token}`);
    expect(mail.text).not.toContain('papá');

    // En la app: "Recibidas" para el pastor, con nombre y contacto; el miembro no la ve.
    const received = await get(pastor.headers, '/prayer-requests?tab=received');
    expect(received.body.items).toHaveLength(1);
    expect(received.body.items[0]).toMatchObject({
      id,
      source: 'form',
      author: { id: null, name: 'Ana Gómez' },
      canReply: true,
      requester: {
        name: 'Ana Gómez',
        phone: '1155550101',
        email: 'ana@visita.test',
        wantsContact: true,
        wallShare: 'named',
        contactedAt: null,
      },
    });
    expect((await get(member.headers, '/prayer-requests?tab=received')).body.items).toHaveLength(0);
    expect((await get(member.headers, `/prayer-requests/${id}`)).status).toBe(404);

    // La exportación de la iglesia no lleva el enlace (ni el hash ni el cifrado).
    const [exported] = await exportRows(church.accountId, 'PrayerRequest');
    expect(exported).not.toHaveProperty('accessTokenHash');
    expect(exported).not.toHaveProperty('accessTokenEnc');
    expect(exported).toMatchObject({ requesterName: 'Ana Gómez' });

    // Auditoría sin el texto ni el contacto.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'prayer.public_submit' } });
    expect(log).toMatchObject({ entityId: String(id), userId: null, accountId: church.accountId });
    expect(`${log.before ?? ''}${log.after ?? ''}`).not.toMatch(/papá|ana@visita/);
  });

  it('valida consentimiento y contacto, ignora a los bots y no atiende iglesias suspendidas', async () => {
    const { church, slug } = await setup();
    const post = (body: object) =>
      request(app)
        .post(api(`/public/${slug}/prayer`))
        .send(body);

    expect((await post({ ...form, consent: false })).status).toBe(400);
    expect((await post({ ...form, phone: '', email: '' })).status).toBe(400);
    expect((await post({ ...form, body: '' })).status).toBe(400);

    const bot = await post({ ...form, website: 'http://spam' });
    expect(bot.status).toBe(201);
    expect(bot.body.token).toBeTruthy();
    expect(await prisma.prayerRequest.count()).toBe(0);

    // Sin nombre, "con mi nombre" queda anónima; sin contacto ni pedido de contacto, vale.
    const { id } = await submit(slug, { body: BODY, wallShare: 'named', consent: true });
    expect(await prisma.prayerRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({
      requesterName: null,
      wallShare: 'anonymous',
      wantsContact: false,
    });
    expect(memoryOutbox.filter((m) => m.subject.includes('Tu petición'))).toHaveLength(0);

    await prisma.account.update({ where: { id: church.accountId }, data: { status: 'suspended' } });
    expect((await request(app).get(api(`/public/${slug}/prayer-form`))).status).toBe(404);
    expect((await post(form)).status).toBe(404);
  });

  it('el enlace privado: ver, contestar, marcar respondida, reabrir y retirar', async () => {
    const { church, slug, pastor } = await setup();
    const { token, id } = await submit(slug);

    const seen = await request(app).get(link(slug, token));
    expect(seen.status).toBe(200);
    expect(seen.body.request).toMatchObject({
      body: BODY,
      status: 'open',
      name: 'Ana Gómez',
      wantsContact: true,
      contacted: false,
      onWall: false,
      prayerCount: 0,
      replies: [],
    });
    expect(seen.body.request).not.toHaveProperty('id');

    // Quien pidió contesta antes de que nadie responda: les llega a los pastores.
    const first = await request(app)
      .post(`${link(slug, token)}/replies`)
      .send({ body: 'Gracias' });
    expect(first.status).toBe(201);
    expect(first.body.replies).toEqual([
      expect.objectContaining({ body: 'Gracias', fromRequester: true, author: 'Ana Gómez', mine: false }),
    ]);
    const toTeam = await prisma.notification.findMany({ where: { type: 'prayer.reply' } });
    expect(toTeam.map((n) => n.userId).sort()).toEqual([pastor.user.id, church.ownerId].sort());

    // Responde el pastor: le llega un mail a quien pidió, sin el texto.
    await prisma.prayerRequestPrayer.create({ data: { requestId: id, userId: pastor.user.id } });
    memoryOutbox.length = 0;
    const answer = await send(pastor.headers, 'post', `/prayer-requests/${id}/replies`, {
      body: 'Estamos orando por tu papá',
    });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ fromRequester: false, mine: true });
    await emailsSettled();
    const mail = memoryOutbox.find((m) => m.to === 'ana@visita.test')!;
    expect(mail.text).toContain(`/orar/${slug}/${token}`);
    expect(mail.text).not.toContain('Estamos orando');

    // Cuando vuelve a contestar, le llega solo a quien ya respondió.
    await prisma.notification.deleteMany();
    await request(app)
      .post(`${link(slug, token)}/replies`)
      .send({ body: '¡Amén!' });
    const again = await prisma.notification.findMany({ where: { type: 'prayer.reply' } });
    expect(again.map((n) => n.userId)).toEqual([pastor.user.id]);

    const view = (await request(app).get(link(slug, token))).body.request;
    expect(view.prayerCount).toBe(1);
    expect(
      view.replies.map((r: { body: string; fromRequester: boolean }) => [r.body, r.fromRequester]),
    ).toEqual([
      ['Gracias', true],
      ['Estamos orando por tu papá', false],
      ['¡Amén!', true],
    ]);
    expect(view.replies[1].author).toBe(`${pastor.user.firstName} ${pastor.user.lastName}`);

    const answered = await request(app)
      .patch(link(slug, token))
      .send({ status: 'answered', testimony: '¡Le dieron el alta!' });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ status: 'answered', testimony: '¡Le dieron el alta!' });
    const reopened = await request(app).patch(link(slug, token)).send({ status: 'open' });
    expect(reopened.body).toMatchObject({ status: 'open', testimony: null, answeredAt: null });

    // No puede cambiar la visibilidad ni el texto desde el enlace.
    expect((await request(app).patch(link(slug, token)).send({ visibility: 'public' })).status).toBe(400);

    expect((await request(app).delete(link(slug, token))).status).toBe(204);
    expect((await request(app).get(link(slug, token))).status).toBe(404);
    expect((await get(pastor.headers, `/prayer-requests/${id}`)).status).toBe(404);

    const actions = (await prisma.auditLog.findMany({ where: { entityId: String(id) } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['prayer.public_update', 'prayer.public_withdraw']));
  });

  it('un enlace no sirve en otra iglesia ni con un token inventado', async () => {
    const { slug } = await setup();
    const other = await setup();
    const { token } = await submit(slug);

    expect((await request(app).get(link(other.slug, token))).status).toBe(404);
    expect(
      (
        await request(app)
          .post(`${link(other.slug, token)}/replies`)
          .send({ body: 'x' })
      ).status,
    ).toBe(404);
    expect((await request(app).get(link(slug, 'a'.repeat(43)))).status).toBe(404);
    expect((await request(app).get(link(slug, 'corto'))).status).toBe(400);
  });

  it('"Contactado": solo con oracion.pastoral y solo en las del formulario', async () => {
    const { church, slug, pastor, member } = await setup();
    const { token, id } = await submit(slug);

    expect((await send(member.headers, 'put', `/prayer-requests/${id}/contacted`)).status).toBe(403);
    const done = await send(pastor.headers, 'put', `/prayer-requests/${id}/contacted`);
    expect(done.status).toBe(200);
    expect(done.body.requester.contactedBy).toBe(`${pastor.user.firstName} ${pastor.user.lastName}`);
    expect((await request(app).get(link(slug, token))).body.request.contacted).toBe(true);

    // Otro pastor lo marca después: queda el primero.
    const other = await actor({ 'oracion.pastoral': 'all' }, church.accountId);
    const again = await send(other.headers, 'put', `/prayer-requests/${id}/contacted`);
    expect(again.body.requester.contactedBy).toBe(`${pastor.user.firstName} ${pastor.user.lastName}`);
    expect(await prisma.auditLog.count({ where: { action: 'prayer.contacted' } })).toBe(1);

    const undone = await send(pastor.headers, 'delete', `/prayer-requests/${id}/contacted`);
    expect(undone.body.requester).toMatchObject({ contactedAt: null, contactedBy: null });

    const own = await send(member.headers, 'post', '/prayer-requests', {
      body: 'Mía',
      visibility: 'pastors',
    });
    const res = await send(pastor.headers, 'put', `/prayer-requests/${own.body.id}/contacted`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRAYER_NOT_FORM');
  });

  it('aislamiento: otra iglesia no ve la petición, sus respuestas ni la puede contactar', async () => {
    const { slug } = await setup();
    const other = await setup();
    const { id } = await submit(slug);

    expect((await get(other.pastor.headers, `/prayer-requests/${id}`)).status).toBe(404);
    expect((await get(other.pastor.headers, `/prayer-requests/${id}/replies`)).status).toBe(404);
    expect(
      (await send(other.pastor.headers, 'post', `/prayer-requests/${id}/replies`, { body: 'x' })).status,
    ).toBe(404);
    expect((await send(other.pastor.headers, 'put', `/prayer-requests/${id}/contacted`)).status).toBe(404);
  });
});

describe('respuestas en las peticiones de la app', () => {
  it('el autor y el equipo conversan; quien la ve en el muro no lee las respuestas', async () => {
    const { pastor, member, church } = await setup();
    const outsider = await actor({}, church.accountId);
    const created = await send(member.headers, 'post', '/prayer-requests', {
      body: 'Por mi examen',
      visibility: 'public',
    });
    const id = created.body.id as number;
    expect(created.body).toMatchObject({ canReply: true, replyCount: 0, requester: null });

    // Quien la ve en el muro no es del equipo: no lee ni escribe respuestas.
    expect((await get(outsider.headers, `/prayer-requests/${id}`)).body.canReply).toBe(false);
    expect((await get(outsider.headers, `/prayer-requests/${id}/replies`)).status).toBe(403);
    expect(
      (await send(outsider.headers, 'post', `/prayer-requests/${id}/replies`, { body: 'x' })).status,
    ).toBe(403);

    // Responde el pastor: aviso al autor.
    const answer = await send(pastor.headers, 'post', `/prayer-requests/${id}/replies`, { body: 'Oramos' });
    expect(answer.status).toBe(201);
    const notice = await prisma.notification.findFirstOrThrow({ where: { type: 'prayer.reply' } });
    expect(notice.userId).toBe(member.user.id);
    expect(JSON.parse(notice.params!)).toMatchObject({ mine: 1 });
    expect(notice.params).not.toContain('Oramos');

    // Contesta el autor: aviso al pastor que respondió.
    await prisma.notification.deleteMany();
    const back = await send(member.headers, 'post', `/prayer-requests/${id}/replies`, { body: 'Gracias' });
    expect(back.body).toMatchObject({ fromRequester: true, mine: true });
    const toPastor = await prisma.notification.findMany({ where: { type: 'prayer.reply' } });
    expect(toPastor.map((n) => n.userId)).toEqual([pastor.user.id]);

    const thread = await get(member.headers, `/prayer-requests/${id}/replies`);
    expect(thread.body.map((r: { body: string }) => r.body)).toEqual(['Oramos', 'Gracias']);
    expect((await get(member.headers, `/prayer-requests/${id}`)).body.replyCount).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'prayer.reply' } })).toBe(2);
  });
});
