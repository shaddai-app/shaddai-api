import { unzipSync, strFromU8 } from 'fflate';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/core/auth/password.js';
import { purgeExpiredAccounts } from '../../src/core/db/account-data.js';
import { TENANT_MODELS } from '../../src/core/db/tenant.js';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import { storage } from '../../src/core/storage/storage.js';
import { actor, app, prisma, provisionChurch, resetDb, STRONG_PASSWORD } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const png = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: '#3b5f94' } })
    .png()
    .toBuffer();

/** Iglesia con algo de todo: una persona, un logo y la contraseña del dueño conocida. */
async function church() {
  const c = await provisionChurch();
  await prisma.user.update({
    where: { id: c.ownerId },
    data: { passwordHash: await hashPassword(STRONG_PASSWORD) },
  });
  const person = await request(app)
    .post(api('/people'))
    .set(c.headers)
    .send({ firstName: 'Marta', lastName: 'Exportada', allowDuplicate: true });
  expect(person.status).toBe(201);
  const logo = await request(app)
    .post(api('/account/logo'))
    .set(c.headers)
    .attach('file', await png(), 'logo.png');
  expect(logo.status).toBe(201);
  const account = await prisma.account.findUniqueOrThrow({ where: { id: c.accountId } });
  return {
    ...c,
    name: account.name,
    personId: person.body.id as number,
    logoFileId: logo.body.logoFileId as number,
  };
}

/** Filas que quedan de una cuenta en todos los modelos con accountId. */
async function rowsOf(accountId: number) {
  let total = 0;
  for (const model of TENANT_MODELS) {
    const delegate = (prisma as unknown as Record<string, { count: (a: object) => Promise<number> }>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ]!;
    total += await delegate.count({ where: { accountId } });
  }
  return total;
}

const close = (headers: Headers, body: object) =>
  request(app).post(api('/account/closure')).set(headers).send(body);

describe('exportación de la iglesia', () => {
  it('ZIP con todos los datos y archivos, sin credenciales, y queda auditada', async () => {
    const c = await church();
    const res = await request(app).get(api('/account/export')).set(c.headers).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="shaddai-.+\.zip"/);

    const files = unzipSync(new Uint8Array(res.body as Buffer));
    const read = (name: string) => JSON.parse(strFromU8(files[name]!)) as Record<string, unknown>[];
    expect(strFromU8(files['LEEME.txt']!)).toContain(c.name);
    expect((read('datos/account.json') as unknown as { name: string }).name).toBe(c.name);
    expect(read('datos/person.json').map((p) => p.lastName)).toContain('Exportada');
    // Usuarios sin contraseña ni secretos; sesiones y tokens no salen.
    const users = read('datos/user.json');
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(u).not.toHaveProperty('passwordHash');
      expect(u).not.toHaveProperty('totpSecretEnc');
    }
    expect(files['datos/refresh-token.json']).toBeUndefined();
    expect(files['datos/password-reset-token.json']).toBeUndefined();
    // El logo, con el id del registro de archivos.
    const logo = Object.keys(files).find((n) => n.startsWith(`archivos/${c.logoFileId}-`));
    expect(logo).toBeDefined();
    expect((await sharp(Buffer.from(files[logo!]!)).metadata()).format).toBe('webp');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId: c.accountId, action: 'account.export' },
    });
    expect(audit?.userId).toBe(c.ownerId);
    // La exportación de otra iglesia no trae nada de esta.
    const other = await provisionChurch();
    const theirs = await request(app)
      .get(api('/account/export'))
      .set(other.headers)
      .buffer(true)
      .parse(binary);
    const theirFiles = unzipSync(new Uint8Array(theirs.body as Buffer));
    expect(strFromU8(theirFiles['datos/person.json']!)).not.toContain('Exportada');
  });

  it('sin permiso de configurar la cuenta, no', async () => {
    const c = await church();
    const member = await actor({ 'personas.ver': 'all' }, c.accountId);
    expect((await request(app).get(api('/account/export')).set(member.headers)).status).toBe(403);
  });
});

describe('baja de la cuenta', () => {
  it('solo el dueño, con el nombre de la iglesia y su contraseña', async () => {
    const c = await church();
    const admin = await actor({ 'cuenta.configurar': 'all' }, c.accountId);
    const ok = { password: STRONG_PASSWORD, confirm: c.name };

    expect((await close(admin.headers, ok)).body.error.code).toBe('ACCOUNT_OWNER_REQUIRED');
    expect((await close(c.headers, { ...ok, confirm: 'Otra iglesia' })).body.error.code).toBe(
      'CLOSURE_CONFIRM_MISMATCH',
    );
    expect((await close(c.headers, { ...ok, password: 'equivocada-de-verdad' })).body.error.code).toBe(
      'PASSWORD_CURRENT_INVALID',
    );
    expect((await prisma.account.findUniqueOrThrow({ where: { id: c.accountId } })).status).toBe('active');
  });

  it('cierra la cuenta, corta las sesiones, avisa por mail y fija la purga a 90 días', async () => {
    const c = await church();
    // Morosa (solo lectura): igual puede irse.
    await prisma.account.update({
      where: { id: c.accountId },
      data: { status: 'past_due', email: 'iglesia@test.local' },
    });
    const res = await close(c.headers, { password: STRONG_PASSWORD, confirm: c.name.toUpperCase() });
    expect(res.status).toBe(200);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: c.accountId } });
    expect(account.status).toBe('closed');
    const days = (account.purgeAfter!.getTime() - account.closedAt!.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    expect(new Date(res.body.purgeAfter as string).getTime()).toBe(account.purgeAfter!.getTime());

    // Nadie de la iglesia puede seguir usando la sesión.
    expect((await request(app).get(api('/account')).set(c.headers)).status).toBe(403);
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: c.ownerId } });
    expect(memoryOutbox.map((m) => m.to).sort()).toEqual(['iglesia@test.local', owner.email].sort());
    expect(memoryOutbox[0]!.text).toContain('soporte@shaddai.local');
    expect(
      await prisma.auditLog.count({ where: { accountId: c.accountId, action: 'account.closure' } }),
    ).toBe(1);
  });
});

describe('purga a los 90 días', () => {
  it('borra todo de la iglesia vencida, archivos incluidos, y no toca a las demás', async () => {
    const gone = await church();
    const kept = await church();
    const closedRecently = await church();
    const logo = await prisma.fileObject.findUniqueOrThrow({ where: { id: gone.logoFileId } });
    expect(await rowsOf(gone.accountId)).toBeGreaterThan(10);
    const keptRows = await rowsOf(kept.accountId);

    const past = new Date(Date.now() - 1_000);
    await prisma.account.update({
      where: { id: gone.accountId },
      data: { status: 'closed', purgeAfter: past },
    });
    await prisma.account.update({
      where: { id: closedRecently.accountId },
      data: { status: 'closed', purgeAfter: new Date(Date.now() + 86_400_000) },
    });

    expect(await purgeExpiredAccounts()).toEqual([gone.accountId]);
    expect(await rowsOf(gone.accountId)).toBe(0);
    expect(await prisma.account.findUnique({ where: { id: gone.accountId } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { accountId: gone.accountId } })).toBe(0);
    await expect(storage.get(logo.storageKey)).rejects.toMatchObject({ code: 'ENOENT' });
    // Queda constancia de la purga, sin datos de la iglesia.
    const record = await prisma.auditLog.findFirstOrThrow({ where: { action: 'platform.account.purged' } });
    expect(record.entityId).toBe(String(gone.accountId));
    expect(record.accountId).toBeNull();

    expect(await rowsOf(kept.accountId)).toBe(keptRows);
    expect(await rowsOf(closedRecently.accountId)).toBeGreaterThan(0);
    expect(await purgeExpiredAccounts()).toEqual([]); // nada más para purgar
  });
});

describe('con datos de todos los módulos (iglesia demo)', () => {
  it('se exporta entera y se purga sin dejar nada', async () => {
    const { seedPlans } = await import('../../prisma/seed/plans.js');
    const { seedDemo } = await import('../../prisma/seed/demo.js');
    process.env.SEED_DEMO = 'true';
    process.env.SEED_DEMO_PASSWORD = 'solo-para-este-test-123';
    try {
      await seedPlans(prisma);
      await seedDemo(prisma);
    } finally {
      delete process.env.SEED_DEMO;
      delete process.env.SEED_DEMO_PASSWORD;
    }
    const demo = await prisma.account.findUniqueOrThrow({ where: { slug: 'iglesia-demo' } });
    const owner = await prisma.user.findFirstOrThrow({ where: { accountId: demo.id, isAccountOwner: true } });
    const login = await request(app)
      .post(api('/auth/login'))
      .send({ email: owner.email, password: 'solo-para-este-test-123' });
    const headers = { Authorization: `Bearer ${login.body.accessToken as string}` };

    const res = await request(app).get(api('/account/export')).set(headers).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    for (const name of [
      'finance-movement',
      'cell-report',
      'consolidation-case',
      'setlist-item',
      'inventory-loan',
    ]) {
      expect(JSON.parse(strFromU8(files[`datos/${name}.json`]!)).length, name).toBeGreaterThan(0);
    }

    const before = await rowsOf(demo.id);
    expect(before).toBeGreaterThan(200);
    await prisma.account.update({
      where: { id: demo.id },
      data: { status: 'closed', purgeAfter: new Date() },
    });
    expect(await purgeExpiredAccounts()).toEqual([demo.id]);
    expect(await rowsOf(demo.id)).toBe(0);
    expect(await prisma.user.count({ where: { email: owner.email } })).toBe(0);
  });
});
