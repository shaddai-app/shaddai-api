import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forgetDemoAccountCache } from '../../src/core/demo.js';
import { DEMO_ACCOUNT_ID, DEMO_SLUG, DEMO_USERS } from '../../src/modules/platform/demo/constants.js';
import { app, bearer, prisma, resetDb } from './helpers.js';

const api = () => request(app);

/** La demo tiene que ser la cuenta 1 también en la base de tests (resetDb no reinicia la identidad). */
async function reseedAccountIdentity() {
  const [row] = await prisma.$queryRawUnsafe<{ used: number }[]>(
    "SELECT CASE WHEN last_value IS NULL THEN 0 ELSE 1 END AS used FROM sys.identity_columns WHERE object_id = OBJECT_ID('Account')",
  );
  await prisma.$executeRawUnsafe(`DBCC CHECKIDENT ('Account', RESEED, ${row!.used ? 0 : 1})`);
}

async function plan(code: string, userLimit: number, extra: { priceArs?: string; isActive?: boolean } = {}) {
  return prisma.plan.create({
    data: { code, name: code, userLimit, storageLimitMb: userLimit * 100, priceUsd: '9.99', ...extra },
  });
}

/** Cuenta demo (id 1) con los 4 usuarios demo, como la deja el seed. */
async function createDemo(slug = DEMO_SLUG) {
  await reseedAccountIdentity();
  const p = await plan('standard', 15);
  const account = await prisma.account.create({
    data: { name: 'Iglesia Demo', slug, status: 'active', planId: p.id, userLimit: 15, storageLimitMb: 50 },
  });
  expect(account.id).toBe(DEMO_ACCOUNT_ID);
  for (const u of DEMO_USERS) {
    await prisma.user.create({
      data: {
        accountId: account.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        passwordHash: 'x',
        mustChangePassword: false,
      },
    });
  }
  forgetDemoAccountCache();
  return account;
}

beforeEach(async () => {
  await resetDb();
  forgetDemoAccountCache();
});
afterAll(() => prisma.$disconnect());

describe('GET /public/plans', () => {
  it('lista los planes activos, sin sesión, con lo justo para la landing', async () => {
    await plan('pro', 40, { priceArs: '45000.50' });
    await plan('basic', 5);
    await plan('old', 10, { isActive: false });

    const res = await api().get('/api/v1/public/plans');
    expect(res.status).toBe(200);
    expect(res.body.trialDays).toBe(30);
    expect(res.body.items).toEqual([
      { code: 'basic', name: 'basic', userLimit: 5, storageLimitMb: 500, priceArs: null },
      { code: 'pro', name: 'pro', userLimit: 40, storageLimitMb: 4000, priceArs: 45000.5 },
    ]);
  });

  it('sin planes devuelve una lista vacía', async () => {
    const res = await api().get('/api/v1/public/plans');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('POST /auth/demo', () => {
  it.each(DEMO_USERS.map((u) => [u.role, u.email]))('entra como %s', async (role, email) => {
    await createDemo();
    const res = await api().post('/api/v1/auth/demo').send({ role });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.headers['set-cookie']?.[0]).toMatch(/^sh_rt=/);

    const me = await api().get('/api/v1/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.account.id).toBe(DEMO_ACCOUNT_ID);
  });

  it('audita el ingreso como demo', async () => {
    await createDemo();
    await api().post('/api/v1/auth/demo').send({ role: 'pastor' }).expect(200);
    const log = await prisma.auditLog.findFirst({ where: { action: 'auth.login.success' } });
    expect(log?.accountId).toBe(DEMO_ACCOUNT_ID);
    expect(JSON.parse(log!.after!)).toEqual({ demo: true });
  });

  it('valida el perfil y no acepta un mail', async () => {
    await createDemo();
    for (const body of [{}, { role: 'member' }, { role: 'admin', email: 'otra@iglesia.org' }]) {
      const res = await api().post('/api/v1/auth/demo').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('sin la cuenta demo, con otro slug o suspendida → DEMO_UNAVAILABLE', async () => {
    let res = await api().post('/api/v1/auth/demo').send({ role: 'admin' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DEMO_UNAVAILABLE');

    await createDemo('otra-iglesia');
    res = await api().post('/api/v1/auth/demo').send({ role: 'admin' });
    expect(res.body.error.code).toBe('DEMO_UNAVAILABLE');

    await prisma.account.update({
      where: { id: DEMO_ACCOUNT_ID },
      data: { slug: DEMO_SLUG, status: 'suspended' },
    });
    forgetDemoAccountCache();
    res = await api().post('/api/v1/auth/demo').send({ role: 'admin' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DEMO_UNAVAILABLE');
  });

  it('un usuario demo con el mail en otra iglesia no entra', async () => {
    await createDemo();
    await prisma.user.update({
      where: { email: DEMO_USERS[1].email },
      data: { email: 'renombrado@shaddai.local' },
    });
    const res = await api().post('/api/v1/auth/demo').send({ role: 'pastor' });
    expect(res.body.error.code).toBe('DEMO_UNAVAILABLE');
  });

  it('entra aunque el usuario demo esté bloqueado por intentos fallidos, y lo desbloquea', async () => {
    await createDemo();
    const email = DEMO_USERS[0].email;
    await prisma.user.update({
      where: { email },
      data: { failedLoginCount: 4, lockoutLevel: 2, lockedUntil: new Date(Date.now() + 3_600_000) },
    });
    const res = await api().post('/api/v1/auth/demo').send({ role: 'admin' });
    expect(res.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.lockedUntil).toBeNull();
    expect(user.failedLoginCount).toBe(0);
  });
});
