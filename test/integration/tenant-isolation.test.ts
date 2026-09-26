import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantClientFor } from '../../src/core/db/tenant.js';
import { actor, app, createAccount, createUser, prisma, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function twoAccounts() {
  const a = await createAccount();
  const b = await createAccount();
  const campusA = await prisma.campus.create({ data: { accountId: a.id, name: 'Sede A', isMain: true } });
  const campusB = await prisma.campus.create({ data: { accountId: b.id, name: 'Sede B', isMain: true } });
  return { a, b, campusA, campusB };
}

describe('cliente Prisma por cuenta', () => {
  it('las lecturas solo ven filas de la cuenta', async () => {
    const { a, campusA, campusB } = await twoAccounts();
    const db = tenantClientFor(a.id);

    expect((await db.campus.findMany()).map((c) => c.id)).toEqual([campusA.id]);
    expect(await db.campus.count()).toBe(1);
    expect(await db.campus.findUnique({ where: { id: campusB.id } })).toBeNull();
    expect(await db.campus.findFirst({ where: { name: 'Sede B' } })).toBeNull();
    // Un accountId explícito de otra cuenta en el where no abre la puerta.
    expect(await db.campus.findMany({ where: { accountId: campusB.accountId } })).toEqual([]);
    const agg = await db.campus.aggregate({ _count: { _all: true } });
    expect(agg._count._all).toBe(1);
  });

  it('las escrituras no alcanzan filas de otra cuenta', async () => {
    const { a, campusB } = await twoAccounts();
    const db = tenantClientFor(a.id);

    await expect(
      db.campus.update({ where: { id: campusB.id }, data: { name: 'hackeada' } }),
    ).rejects.toMatchObject({
      code: 'P2025',
    });
    await expect(db.campus.delete({ where: { id: campusB.id } })).rejects.toMatchObject({ code: 'P2025' });
    expect((await db.campus.updateMany({ data: { address: 'x' } })).count).toBe(1);
    expect((await db.campus.deleteMany({ where: { id: campusB.id } })).count).toBe(0);

    const untouched = await prisma.campus.findUniqueOrThrow({ where: { id: campusB.id } });
    expect(untouched.name).toBe('Sede B');
    expect(untouched.address).toBeNull();
  });

  it('create fuerza el accountId de la cuenta y update no permite moverlo', async () => {
    const { a, b } = await twoAccounts();
    const db = tenantClientFor(a.id);

    const created = await db.campus.create({ data: { accountId: b.id, name: 'Intento' } });
    expect(created.accountId).toBe(a.id);
    await db.campus.createMany({ data: [{ accountId: b.id, name: 'Lote' }] });
    expect(await prisma.campus.count({ where: { accountId: b.id } })).toBe(1);

    const moved = await db.campus.update({ where: { id: created.id }, data: { accountId: b.id } });
    expect(moved.accountId).toBe(a.id);
  });

  it('la cuenta solo se ve a sí misma y no puede crear ni borrar cuentas', async () => {
    const { a, b } = await twoAccounts();
    const db = tenantClientFor(a.id);
    expect((await db.account.findMany()).map((x) => x.id)).toEqual([a.id]);
    expect(await db.account.findUnique({ where: { id: b.id } })).toBeNull();
    await expect(db.account.update({ where: { id: b.id }, data: { name: 'x' } })).rejects.toMatchObject({
      code: 'P2025',
    });
    await expect(db.account.delete({ where: { id: a.id } })).rejects.toMatchObject({
      code: 'TENANT_ACCOUNT_WRITE_FORBIDDEN',
    });
  });

  it('tablas hijas (UserRole) se filtran por su padre y no aceptan padres ajenos', async () => {
    const { a, b } = await twoAccounts();
    const userA = await createUser({ accountId: a.id });
    const userB = await createUser({ accountId: b.id });
    const roleA = await prisma.role.create({ data: { accountId: a.id, name: 'Rol A' } });
    const roleB = await prisma.role.create({ data: { accountId: b.id, name: 'Rol B' } });
    await prisma.userRole.create({ data: { userId: userB.id, roleId: roleB.id } });

    const db = tenantClientFor(a.id);
    expect(await db.userRole.findMany()).toEqual([]);
    // Asignar un rol de otra cuenta, o a un usuario de otra cuenta, falla con 404.
    await expect(db.userRole.create({ data: { userId: userA.id, roleId: roleB.id } })).rejects.toMatchObject({
      status: 404,
    });
    await expect(db.userRole.create({ data: { userId: userB.id, roleId: roleA.id } })).rejects.toMatchObject({
      status: 404,
    });
    await db.userRole.create({ data: { userId: userA.id, roleId: roleA.id } });
    expect(await db.userRole.count()).toBe(1);
    expect((await db.userRole.deleteMany()).count).toBe(1);
    expect(await prisma.userRole.count()).toBe(1); // la de la cuenta B sigue ahí
  });

  it('el filtro también aplica dentro de transacciones interactivas', async () => {
    const { a, campusB } = await twoAccounts();
    const db = tenantClientFor(a.id);
    const seen = await db.$transaction(async (tx) => tx.campus.findUnique({ where: { id: campusB.id } }));
    expect(seen).toBeNull();
  });
});

describe('endpoints de sedes entre cuentas', () => {
  it('un usuario de A no ve ni modifica sedes de B (404, no 403)', async () => {
    const { a, campusA, campusB } = await twoAccounts();
    const admin = await actor({ 'estructura.gestionar': 'all' }, a.id);

    const list = await request(app).get('/api/v1/campuses').set(admin.headers);
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { id: number }) => c.id)).toEqual([campusA.id]);

    expect((await request(app).get(`/api/v1/campuses/${campusB.id}`).set(admin.headers)).status).toBe(404);
    const patch = await request(app)
      .patch(`/api/v1/campuses/${campusB.id}`)
      .set(admin.headers)
      .send({ name: 'x' });
    expect(patch.status).toBe(404);
    expect((await prisma.campus.findUniqueOrThrow({ where: { id: campusB.id } })).name).toBe('Sede B');
  });

  it('crear con accountId ajeno en el body es rechazado por validación', async () => {
    const { a, b } = await twoAccounts();
    const admin = await actor({ 'estructura.gestionar': 'all' }, a.id);
    const res = await request(app)
      .post('/api/v1/campuses')
      .set(admin.headers)
      .send({ name: 'Anexo', accountId: b.id });
    expect(res.status).toBe(400);
    expect(await prisma.campus.count({ where: { accountId: b.id } })).toBe(1);
  });

  it('marcar otra sede como principal desmarca la anterior solo dentro de la cuenta', async () => {
    const { a, b, campusA } = await twoAccounts();
    const admin = await actor({ 'estructura.gestionar': 'all' }, a.id);
    const res = await request(app)
      .post('/api/v1/campuses')
      .set(admin.headers)
      .send({ name: 'Nueva', isMain: true });
    expect(res.status).toBe(201);
    expect((await prisma.campus.findUniqueOrThrow({ where: { id: campusA.id } })).isMain).toBe(false);
    expect(await prisma.campus.count({ where: { accountId: b.id, isMain: true } })).toBe(1);

    const demote = await request(app)
      .patch(`/api/v1/campuses/${res.body.id}`)
      .set(admin.headers)
      .send({ isMain: false });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('CAMPUS_MAIN_REQUIRED');
  });

  it('las escrituras quedan auditadas con cuenta y usuario', async () => {
    const { a } = await twoAccounts();
    const admin = await actor({ 'estructura.gestionar': 'all' }, a.id);
    const res = await request(app).post('/api/v1/campuses').set(admin.headers).send({ name: 'Anexo Norte' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'structure.campus.create' } });
    expect(log).toMatchObject({ accountId: a.id, userId: admin.user.id, entityId: String(res.body.id) });
  });
});
