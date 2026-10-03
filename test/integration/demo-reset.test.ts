import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_DATA } from '../../src/core/db/account-data.js';
import { tenantClientFor } from '../../src/core/db/tenant.js';
import {
  DEMO_ACCOUNT_ID,
  DEMO_ADMIN_EMAIL,
  DEMO_SLUG,
  DEMO_USERS,
} from '../../src/modules/platform/demo/constants.js';
import { app, createUser, loginAs, platformAdmin, prisma, provisionChurch, resetDb } from './helpers.js';
import { TEST_DEMO_PASSWORD } from './test-env.js';

const api = () => request(app);
const credentials = { accountId: DEMO_ACCOUNT_ID, email: DEMO_ADMIN_EMAIL, password: TEST_DEMO_PASSWORD };

/**
 * Modelos que la demo puede tener vacíos, con su porqué. Todo lo demás de ACCOUNT_DATA tiene que tener
 * datos de ejemplo: un módulo nuevo suma su seedDemo<Algo> en src/modules/platform/demo/data.ts.
 */
const EMPTY_IN_DEMO: Record<string, string> = {
  RefreshToken: 'sesiones: el reset las cierra',
  PasswordResetToken: 'tokens de un solo uso',
  TotpRecoveryCode: 'los usuarios demo no tienen 2FA',
  DailyJobRun: 'lo escribe el programador, no el seed',
  Invoice: 'la demo no se cobra',
  Subscription: 'la demo no se cobra',
  FileObject: 'los binarios necesitan el almacenamiento: sin archivos de ejemplo',
  MovementAttachment: 'comprobantes: son archivos',
  ImportJob: 'historial de importaciones de planillas',
};

type Counter = { count: (args?: object) => Promise<number> };
const delegate = (model: string) =>
  (tenantClientFor(DEMO_ACCOUNT_ID) as unknown as Record<string, Counter>)[
    model.charAt(0).toLowerCase() + model.slice(1)
  ]!;

async function countAll() {
  const counts: Record<string, number> = {};
  for (const { model } of ACCOUNT_DATA) counts[model] = await delegate(model).count();
  return counts;
}

/** La demo tiene que ser la cuenta 1 también en la base de tests (resetDb no reinicia la identidad). */
async function reseedAccountIdentity() {
  const [row] = await prisma.$queryRawUnsafe<{ used: number }[]>(
    "SELECT CASE WHEN last_value IS NULL THEN 0 ELSE 1 END AS used FROM sys.identity_columns WHERE object_id = OBJECT_ID('Account')",
  );
  // Con valores ya usados, el próximo id es reseed + 1; en una tabla nunca usada, es el reseed.
  await prisma.$executeRawUnsafe(`DBCC CHECKIDENT ('Account', RESEED, ${row!.used ? 0 : 1})`);
}

let headers: Record<string, string>;
let baseline: Record<string, number>;
let otherChurch: Awaited<ReturnType<typeof provisionChurch>>;

beforeAll(async () => {
  await resetDb();
  await reseedAccountIdentity();
  const { seedPlans } = await import('../../prisma/seed/plans.js');
  const { seedDemo } = await import('../../prisma/seed/demo.js');
  await seedPlans(prisma);
  process.env.SEED_DEMO = 'true';
  await seedDemo(prisma);
  delete process.env.SEED_DEMO;
  baseline = await countAll();
  otherChurch = await provisionChurch();
  headers = (await platformAdmin()).headers;
}, 300_000);
afterAll(() => prisma.$disconnect());

describe('restablecer la demo', () => {
  it('la demo quedó como la cuenta 1', async () => {
    const account = await prisma.account.findUniqueOrThrow({ where: { id: DEMO_ACCOUNT_ID } });
    expect(account.slug).toBe(DEMO_SLUG);
    const res = await api().get(`/api/v1/platform/accounts/${DEMO_ACCOUNT_ID}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.isDemo).toBe(true);
    expect(res.body.lastDemoResetAt).toBeNull();
  });

  it('rechaza credenciales que no son las de la demo y no borra nada', async () => {
    const people = await delegate('Person').count();
    for (const body of [
      { ...credentials, password: 'otra-contraseña-cualquiera' },
      { ...credentials, email: 'otra-iglesia@test.local' },
    ]) {
      const res = await api().post('/api/v1/platform/demo/reset').set(headers).send(body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('DEMO_CREDENTIALS_INVALID');
    }
    expect(await delegate('Person').count()).toBe(people);
    const denied = await prisma.auditLog.findMany({ where: { action: 'platform.demo.reset_denied' } });
    expect(denied).toHaveLength(2);
    expect(JSON.stringify(denied.map((d) => d.after))).not.toContain('otra-contraseña-cualquiera');
    expect(denied.map((d) => JSON.parse(d.after!).emailMatches).sort()).toEqual([false, true]);
  });

  it('rechaza si la pantalla apunta a otra cuenta', async () => {
    const res = await api()
      .post('/api/v1/platform/demo/reset')
      .set(headers)
      .send({ ...credentials, accountId: otherChurch.accountId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEMO_CONFIRMATION_MISMATCH');
  });

  it('se niega si la cuenta 1 no es la demo', async () => {
    await prisma.account.update({ where: { id: DEMO_ACCOUNT_ID }, data: { slug: 'iglesia-real' } });
    const res = await api().post('/api/v1/platform/demo/reset').set(headers).send(credentials);
    await prisma.account.update({ where: { id: DEMO_ACCOUNT_ID }, data: { slug: DEMO_SLUG } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEMO_ACCOUNT_INVALID');
    expect(await countAll()).toEqual(baseline);
  });

  it('se niega si un usuario demo es de otra iglesia', async () => {
    const pastor = await prisma.user.findUniqueOrThrow({ where: { email: 'demo-pastor@shaddai.local' } });
    await prisma.user.update({ where: { id: pastor.id }, data: { accountId: otherChurch.accountId } });
    const res = await api().post('/api/v1/platform/demo/reset').set(headers).send(credentials);
    await prisma.user.update({ where: { id: pastor.id }, data: { accountId: DEMO_ACCOUNT_ID } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEMO_ACCOUNT_INVALID');
    expect(await countAll()).toEqual(baseline);
  });

  it('un solo restablecimiento a la vez', async () => {
    await prisma.platformLock.create({
      data: { key: 'demo-reset', lockedUntil: new Date(Date.now() + 60_000) },
    });
    const res = await api().post('/api/v1/platform/demo/reset').set(headers).send(credentials);
    await prisma.platformLock.deleteMany();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEMO_RESET_IN_PROGRESS');
  });

  it('la demo no se puede suspender ni cerrar', async () => {
    for (const status of ['suspended', 'closed']) {
      const res = await api()
        .post(`/api/v1/platform/accounts/${DEMO_ACCOUNT_ID}/status`)
        .set(headers)
        .send({ status, reason: 'prueba de protección' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DEMO_ACCOUNT_PROTECTED');
    }
  });

  it('deja la demo como recién creada sin tocar otras iglesias', async () => {
    const demoUsers = await prisma.user.findMany({
      where: { accountId: DEMO_ACCOUNT_ID, email: { in: DEMO_USERS.map((u) => u.email) } },
      select: { id: true, email: true },
    });
    const otherBefore = await tenantClientFor(otherChurch.accountId).role.count();

    // Lo que hace un visitante: datos nuevos, un usuario, cambios en la cuenta y en el admin demo.
    const visitor = await createUser({ accountId: DEMO_ACCOUNT_ID });
    const qa = await prisma.user.update({
      where: { id: (await createUser({ accountId: DEMO_ACCOUNT_ID })).id },
      data: { email: 'qa-admin@shaddai.local' },
    });
    const status = await prisma.catalogItem.findFirstOrThrow({
      where: { accountId: DEMO_ACCOUNT_ID, type: 'person_status' },
    });
    await prisma.person.create({
      data: { accountId: DEMO_ACCOUNT_ID, firstName: 'Visitante', lastName: 'Curioso', statusId: status.id },
    });
    await prisma.account.update({
      where: { id: DEMO_ACCOUNT_ID },
      data: { name: 'Iglesia Rota', status: 'past_due', currency: 'USD' },
    });
    await loginAs({ email: DEMO_ADMIN_EMAIL, password: TEST_DEMO_PASSWORD });
    await prisma.user.update({
      where: { email: DEMO_ADMIN_EMAIL },
      data: { totpEnabled: true, passwordHash: 'x', firstName: 'Hackeado' },
    });

    const res = await api().post('/api/v1/platform/demo/reset').set(headers).send(credentials);
    expect(res.status).toBe(200);
    expect(res.body.deletedRows).toBeGreaterThan(0);

    // Igual que recién creada, más el usuario QA que sobrevive.
    expect(await countAll()).toEqual({
      ...baseline,
      User: baseline.User! + 1,
      UserRole: baseline.UserRole! + 1,
    });
    expect(await prisma.user.findUnique({ where: { id: visitor.id } })).toBeNull();
    const after = await prisma.user.findMany({
      where: { accountId: DEMO_ACCOUNT_ID, email: { in: DEMO_USERS.map((u) => u.email) } },
      select: { id: true, email: true, totpEnabled: true, firstName: true },
    });
    expect(after.map((u) => u.id).sort()).toEqual(demoUsers.map((u) => u.id).sort());
    expect(after.every((u) => !u.totpEnabled)).toBe(true);
    expect(after.find((u) => u.email === DEMO_ADMIN_EMAIL)!.firstName).toBe('Admin');

    // Fuera de producción, el usuario QA sobrevive con su id y su rol por defecto.
    const qaAfter = await prisma.user.findUniqueOrThrow({
      where: { id: qa.id },
      include: { roles: { include: { role: true } } },
    });
    expect(qaAfter.roles.map((r) => r.role.systemKey)).toEqual(['admin']);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: DEMO_ACCOUNT_ID } });
    expect(account).toMatchObject({ name: 'Iglesia Demo', status: 'active', currency: 'ARS' });
    expect(await tenantClientFor(otherChurch.accountId).role.count()).toBe(otherBefore);
    expect(await prisma.account.findUnique({ where: { id: otherChurch.accountId } })).not.toBeNull();

    const audit = await prisma.auditLog.findMany({ where: { accountId: DEMO_ACCOUNT_ID } });
    // La auditoría vieja (el login del visitante) se borró; queda la del seed y el registro del reset.
    const actions = audit.map((a) => a.action);
    expect(actions.filter((a) => a === 'platform.demo.reset')).toHaveLength(1);
    expect(actions).not.toContain('auth.login.success');
    const detail = await api().get(`/api/v1/platform/accounts/${DEMO_ACCOUNT_ID}`).set(headers);
    expect(detail.body.lastDemoResetAt).not.toBeNull();
    await loginAs({ email: DEMO_ADMIN_EMAIL, password: TEST_DEMO_PASSWORD });
  }, 300_000);

  it('todo dato de iglesia tiene ejemplos en la demo (regla para módulos nuevos)', async () => {
    const counts = await countAll();
    const empty = Object.entries(counts)
      .filter(([model, n]) => n === 0 && !(model in EMPTY_IN_DEMO))
      .map(([model]) => model);
    expect(empty, 'sumá datos de ejemplo en src/modules/platform/demo/data.ts').toEqual([]);
  });
});
