import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/core/auth/tokens.js';
import { forgetDemoAccountCache } from '../../src/core/demo.js';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import { DEMO_ACCOUNT_ID, DEMO_ADMIN_EMAIL, DEMO_SLUG } from '../../src/modules/platform/demo/constants.js';
import { bearer, loginAs, prisma, provisionChurch, resetDb, STRONG_PASSWORD, app } from './helpers.js';

const api = () => request(app);
const BLOCKED = 'DEMO_ACTION_BLOCKED';

/** La demo tiene que ser la cuenta 1 también en la base de tests (resetDb no reinicia la identidad). */
async function reseedAccountIdentity() {
  const [row] = await prisma.$queryRawUnsafe<{ used: number }[]>(
    "SELECT CASE WHEN last_value IS NULL THEN 0 ELSE 1 END AS used FROM sys.identity_columns WHERE object_id = OBJECT_ID('Account')",
  );
  await prisma.$executeRawUnsafe(`DBCC CHECKIDENT ('Account', RESEED, ${row!.used ? 0 : 1})`);
}

let demo: { headers: Record<string, string>; pastorId: number };
let other: Awaited<ReturnType<typeof provisionChurch>>;

beforeAll(async () => {
  await resetDb();
  await reseedAccountIdentity();
  const { createAccount } = await import('../../src/modules/platform/platform.service.js');
  const plan = await prisma.plan.create({
    data: { code: 'standard', name: 'Estándar', userLimit: 15, storageLimitMb: 50, priceUsd: '0' },
  });
  const created = await createAccount({
    name: 'Iglesia Demo',
    slug: DEMO_SLUG,
    planId: plan.id,
    status: 'active',
    trialDays: 30,
    defaultLocale: 'es',
    timezone: 'America/Argentina/Buenos_Aires',
    currency: 'ARS',
    sendAccessEmail: false,
    admin: { email: DEMO_ADMIN_EMAIL, firstName: 'Admin', lastName: 'Demo' },
  });
  expect(created.account.id).toBe(DEMO_ACCOUNT_ID);
  const { hashPassword } = await import('../../src/core/auth/password.js');
  await prisma.user.update({
    where: { id: created.admin.id },
    data: { mustChangePassword: false, passwordHash: await hashPassword(STRONG_PASSWORD) },
  });
  const pastor = await prisma.user.create({
    data: {
      accountId: DEMO_ACCOUNT_ID,
      email: 'demo-pastor@shaddai.local',
      firstName: 'Pastor',
      lastName: 'Demo',
      passwordHash: 'x',
      mustChangePassword: false,
    },
  });
  forgetDemoAccountCache();
  const session = await loginAs({ email: DEMO_ADMIN_EMAIL, password: STRONG_PASSWORD });
  demo = { headers: bearer(session.accessToken), pastorId: pastor.id };
  other = await provisionChurch();
}, 120_000);
beforeEach(() => {
  memoryOutbox.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('bloqueos de la iglesia demo', () => {
  it('la seguridad de los usuarios demo no se toca', async () => {
    const calls = [
      api().post('/api/v1/auth/change-password').send({ currentPassword: STRONG_PASSWORD, newPassword: 'x' }),
      api().post('/api/v1/auth/2fa/enroll').send({}),
      api().post('/api/v1/auth/2fa/confirm').send({ code: '123456' }),
      api().post('/api/v1/auth/2fa/disable').send({ password: STRONG_PASSWORD, code: '123456' }),
      api().post('/api/v1/auth/2fa/recovery-codes').send({ password: STRONG_PASSWORD }),
      api().post('/api/v1/auth/logout-all').send({}),
      api().delete('/api/v1/me/sessions/00000000-0000-4000-8000-000000000000'),
    ];
    for (const call of calls) {
      const res = await call.set(demo.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe(BLOCKED);
    }
  });

  it('sin exportar, baja ni facturación', async () => {
    const calls = [
      api().get('/api/v1/account/export'),
      api().post('/api/v1/account/closure').send({ password: STRONG_PASSWORD, confirm: 'Iglesia Demo' }),
      api().post('/api/v1/account/billing/subscribe').send({}),
      api().post('/api/v1/account/billing/cancel').send({}),
      api().post('/api/v1/account/billing/simulate-payment').send({}),
    ];
    for (const call of calls) {
      const res = await call.set(demo.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe(BLOCKED);
    }
    expect(await prisma.account.findUniqueOrThrow({ where: { id: DEMO_ACCOUNT_ID } })).toMatchObject({
      status: 'active',
    });
  });

  it('los 4 usuarios demo no se editan, desactivan ni resetean', async () => {
    const id = demo.pastorId;
    const calls = [
      api().patch(`/api/v1/users/${id}`).send({ firstName: 'Otro' }),
      api().post(`/api/v1/users/${id}/deactivate`).send({}),
      api().post(`/api/v1/users/${id}/activate`).send({}),
      api().post(`/api/v1/users/${id}/unlock`).send({}),
      api().post(`/api/v1/users/${id}/reset-2fa`).send({}),
      api().post(`/api/v1/users/${id}/reset-password`).send({}),
    ];
    for (const call of calls) {
      const res = await call.set(demo.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe(BLOCKED);
    }
    const list = await api().get('/api/v1/users').set(demo.headers);
    const pastor = list.body.items.find((u: { id: number }) => u.id === id);
    expect(pastor.isDemoUser).toBe(true);
  });

  it('se pueden crear usuarios, pero no sale ningún mail', async () => {
    const res = await api().post('/api/v1/users').set(demo.headers).send({
      email: 'alguien-real@ejemplo.com',
      firstName: 'Visitante',
      lastName: 'Nuevo',
      sendAccessEmail: true,
    });
    expect(res.status).toBe(201);
    expect(memoryOutbox).toHaveLength(0);
    const id = res.body.user?.id ?? res.body.id;
    const list = await api().get('/api/v1/users').set(demo.headers);
    expect(list.body.items.find((u: { id: number }) => u.id === id).isDemoUser).toBe(false);
    // Los usuarios que crea un visitante sí se manejan.
    const off = await api().post(`/api/v1/users/${id}/deactivate`).set(demo.headers).send({});
    expect(off.status).toBe(200);
  });

  it('olvidé mi contraseña: misma respuesta, sin enlace ni mail', async () => {
    const res = await api().post('/api/v1/auth/forgot').send({ email: DEMO_ADMIN_EMAIL });
    expect(res.status).toBe(202);
    expect(memoryOutbox).toHaveLength(0);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_ADMIN_EMAIL } });
    expect(await prisma.passwordResetToken.count({ where: { userId: admin.id } })).toBe(0);

    await prisma.passwordResetToken.create({
      data: {
        userId: admin.id,
        tokenHash: hashToken('token-demo-de-prueba-0123456789abcdef0123456789abcdef'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const reset = await api().post('/api/v1/auth/reset').send({
      token: 'token-demo-de-prueba-0123456789abcdef0123456789abcdef',
      newPassword: 'montaña-violeta-tranvía-azul',
    });
    expect(reset.status).toBe(403);
    expect(reset.body.error.code).toBe(BLOCKED);
  });

  it('el front sabe que es la demo', async () => {
    const me = await api().get('/api/v1/me').set(demo.headers);
    expect(me.body.account.isDemo).toBe(true);
    expect(me.body.user.isDemoUser).toBe(true);
    const otherMe = await api().get('/api/v1/me').set(other.headers);
    expect(otherMe.body.account.isDemo).toBe(false);
  });

  it('otra iglesia no tiene bloqueos', async () => {
    const exp = await api().get('/api/v1/account/export').set(other.headers);
    expect(exp.status).toBe(200);
    await api()
      .post('/api/v1/auth/forgot')
      .send({ email: (await ownerOf(other.ownerId)).email });
    expect(memoryOutbox).toHaveLength(1);
  });

  it('si la cuenta 1 no es la demo, no se bloquea nada', async () => {
    await prisma.account.update({ where: { id: DEMO_ACCOUNT_ID }, data: { slug: 'iglesia-real' } });
    forgetDemoAccountCache();
    try {
      const res = await api().post(`/api/v1/users/${demo.pastorId}/deactivate`).set(demo.headers).send({});
      expect(res.status).toBe(200);
    } finally {
      await prisma.account.update({ where: { id: DEMO_ACCOUNT_ID }, data: { slug: DEMO_SLUG } });
      forgetDemoAccountCache();
    }
  });
});

const ownerOf = (id: number) => prisma.user.findUniqueOrThrow({ where: { id }, select: { email: true } });
