import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/core/rbac/catalog.js';
import {
  actor,
  app,
  bearer,
  createAccountUser,
  loginAs,
  platformAdmin,
  prisma,
  provisionChurch,
  resetDb,
} from './helpers.js';

const api = () => request(app);

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function addUser(headers: Record<string, string>, roleIds: number[] = [], email?: string) {
  return api()
    .post('/api/v1/users')
    .set(headers)
    .send({
      email: email ?? `u${Math.random().toString(36).slice(2)}@test.local`,
      firstName: 'Ana',
      lastName: 'Gómez',
      roleIds,
    });
}

describe('usuarios de la cuenta', () => {
  it('lista con uso del límite y crea usuarios con contraseña temporal y roles', async () => {
    const church = await provisionChurch();
    const list = await api().get('/api/v1/users').set(church.headers);
    expect(list.body).toMatchObject({ total: 1, usage: { activeUsers: 1, userLimit: 10 } });
    expect(list.body.items[0]).toMatchObject({ isAccountOwner: true, isAdmin: true });

    const created = await addUser(church.headers, [church.roleId('cell_leader')], 'Lider@Test.local');
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({
      email: 'lider@test.local',
      mustChangePassword: true,
      isAdmin: false,
    });
    expect(created.body.user.roles.map((r: { systemKey: string }) => r.systemKey)).toEqual(['cell_leader']);

    const login = await loginAs({ email: 'lider@test.local', password: created.body.temporaryPassword });
    expect(login.body.restriction).toBe('password_change');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'users.create' } });
    expect(log.after).not.toContain(created.body.temporaryPassword);
  });

  it('respeta el límite de usuarios: bloquea altas y reactivaciones, nunca desactiva', async () => {
    const church = await provisionChurch({ userLimit: 2 });
    const second = await addUser(church.headers);
    expect(second.status).toBe(201);
    const third = await addUser(church.headers);
    expect(third.status).toBe(409);
    expect(third.body.error).toMatchObject({
      code: 'USER_LIMIT_REACHED',
      details: { activeUsers: 2, userLimit: 2 },
    });

    // Desactivar libera un lugar; reactivar con la cuenta llena vuelve a fallar.
    const id = second.body.user.id;
    await api().post(`/api/v1/users/${id}/deactivate`).set(church.headers);
    expect((await addUser(church.headers)).status).toBe(201);
    const reactivate = await api().post(`/api/v1/users/${id}/activate`).set(church.headers);
    expect(reactivate.body.error.code).toBe('USER_LIMIT_REACHED');

    // Bajar el límite por debajo del uso no desactiva a nadie.
    await prisma.account.update({ where: { id: church.accountId }, data: { userLimit: 1 } });
    expect((await api().get('/api/v1/users?status=active').set(church.headers)).body.total).toBe(2);
  });

  it('email único en la plataforma sin revelar la otra cuenta; roles ajenos rechazados', async () => {
    const church = await provisionChurch();
    const outsider = await createAccountUser();
    const dup = await addUser(church.headers, [], outsider.email);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');

    const other = await provisionChurch();
    const foreignRole = await addUser(church.headers, [other.roleId('pastor')]);
    expect(foreignRole.status).toBe(400);
    expect(foreignRole.body.error.code).toBe('ROLE_INVALID');
  });

  it('protege al dueño y nunca deja la cuenta sin administrador activo', async () => {
    const church = await provisionChurch();
    const admin = church.roleId('admin');

    const removeOwnerAdmin = await api()
      .patch(`/api/v1/users/${church.ownerId}`)
      .set(church.headers)
      .send({ roleIds: [church.roleId('pastor')] });
    expect(removeOwnerAdmin.body.error.code).toBe('OWNER_PROTECTED');
    expect(
      (await api().post(`/api/v1/users/${church.ownerId}/deactivate`).set(church.headers)).body.error.code,
    ).toBe('CANNOT_DEACTIVATE_SELF');

    const second = await addUser(church.headers, [admin]);
    const secondId = second.body.user.id;
    // Con el dueño activo, sacarle el admin al segundo está permitido.
    expect(
      (await api().patch(`/api/v1/users/${secondId}`).set(church.headers).send({ roleIds: [] })).status,
    ).toBe(200);

    // Si el segundo fuera el único admin activo, no se le puede quitar.
    await api()
      .patch(`/api/v1/users/${secondId}`)
      .set(church.headers)
      .send({ roleIds: [admin] });
    await prisma.user.update({ where: { id: church.ownerId }, data: { isActive: false } });
    const { issueSession } = await import('../../src/modules/auth/session.service.js');
    const secondUser = await prisma.user.findUniqueOrThrow({
      where: { id: secondId },
      include: { account: true },
    });
    await prisma.user.update({ where: { id: secondId }, data: { mustChangePassword: false } });
    const session = await issueSession({ ...secondUser, mustChangePassword: false }, false);
    const res = await api()
      .patch(`/api/v1/users/${secondId}`)
      .set(bearer(session.accessToken))
      .send({ roleIds: [church.roleId('pastor')] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
  });

  it('desactivar corta sesiones; reset y desbloqueo por el admin', async () => {
    const church = await provisionChurch();
    const created = await addUser(church.headers, [church.roleId('member')]);
    const id = created.body.user.id;
    await prisma.user.update({ where: { id }, data: { mustChangePassword: false } });
    const session = await loginAs({
      email: created.body.user.email,
      password: created.body.temporaryPassword,
    });

    await api().post(`/api/v1/users/${id}/deactivate`).set(church.headers);
    expect((await api().get('/api/v1/me').set(bearer(session.accessToken))).status).toBe(403);
    await api().post(`/api/v1/users/${id}/activate`).set(church.headers);

    await prisma.user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() + 3_600_000) } });
    const unlocked = await api().post(`/api/v1/users/${id}/unlock`).set(church.headers);
    expect(unlocked.body.locked).toBe(false);

    const reset = await api().post(`/api/v1/users/${id}/reset-password`).set(church.headers).send({});
    expect(reset.status).toBe(200);
    const again = await loginAs({ email: created.body.user.email, password: reset.body.temporaryPassword });
    expect(again.body.restriction).toBe('password_change');

    const self = await api()
      .post(`/api/v1/users/${church.ownerId}/reset-password`)
      .set(church.headers)
      .send({});
    expect(self.body.error.code).toBe('USE_CHANGE_PASSWORD');
  });

  it('no ve ni modifica usuarios de otra cuenta', async () => {
    const church = await provisionChurch();
    const other = await provisionChurch();
    expect((await api().get(`/api/v1/users/${other.ownerId}`).set(church.headers)).status).toBe(404);
    expect((await api().post(`/api/v1/users/${other.ownerId}/deactivate`).set(church.headers)).status).toBe(
      404,
    );
    expect(
      (await api().post(`/api/v1/users/${other.ownerId}/reset-password`).set(church.headers).send({})).status,
    ).toBe(404);
    const list = await api().get('/api/v1/users').set(church.headers);
    expect(list.body.items.map((u: { id: number }) => u.id)).toEqual([church.ownerId]);
  });

  it('usuarios.ver sin usuarios.gestionar: puede listar, no crear', async () => {
    const reader = await actor({ 'usuarios.ver': 'all' });
    expect((await api().get('/api/v1/users').set(reader.headers)).status).toBe(200);
    expect((await addUser(reader.headers)).status).toBe(403);
  });
});

describe('roles y matriz', () => {
  it('lista los roles por defecto; el Administrador muestra todos los permisos', async () => {
    const church = await provisionChurch();
    const res = await api().get('/api/v1/roles').set(church.headers);
    expect(res.body.items).toHaveLength(11);
    const admin = res.body.items.find((r: { systemKey: string }) => r.systemKey === 'admin');
    expect(admin).toMatchObject({ isLocked: true, userCount: 1 });
    expect(Object.keys(admin.grants)).toHaveLength(PERMISSIONS.length);
  });

  it('crea, edita y borra roles validando alcances', async () => {
    const church = await provisionChurch();
    const bad = await api()
      .post('/api/v1/roles')
      .set(church.headers)
      .send({ name: 'Ujieres', grants: { 'personas.crear': 'own' } });
    expect(bad.body.error.code).toBe('SCOPE_NOT_SUPPORTED');
    const unknown = await api()
      .post('/api/v1/roles')
      .set(church.headers)
      .send({ name: 'Rol raro', grants: { 'nada.ver': 'all' } });
    expect(unknown.body.error.code).toBe('PERMISSION_UNKNOWN');

    const created = await api()
      .post('/api/v1/roles')
      .set(church.headers)
      .send({ name: 'Ujieres', grants: { 'eventos.ver': 'all', 'celulas.ver': 'own' } });
    expect(created.status).toBe(201);
    expect(created.body.grants).toEqual({ 'eventos.ver': 'all', 'celulas.ver': 'own' });

    const renamed = await api()
      .patch(`/api/v1/roles/${created.body.id}`)
      .set(church.headers)
      .send({ name: 'Ujieres y recepción' });
    expect(renamed.body.name).toBe('Ujieres y recepción');
    expect(
      (await api().post('/api/v1/roles').set(church.headers).send({ name: 'Ujieres y recepción' })).status,
    ).toBe(409);

    const user = await addUser(church.headers, [created.body.id]);
    expect((await api().delete(`/api/v1/roles/${created.body.id}`).set(church.headers)).body.error.code).toBe(
      'ROLE_IN_USE',
    );
    await api().patch(`/api/v1/users/${user.body.user.id}`).set(church.headers).send({ roleIds: [] });
    expect((await api().delete(`/api/v1/roles/${created.body.id}`).set(church.headers)).status).toBe(204);
  });

  it('el rol Administrador no se puede editar ni borrar', async () => {
    const church = await provisionChurch();
    const id = church.roleId('admin');
    expect(
      (await api().patch(`/api/v1/roles/${id}`).set(church.headers).send({ name: 'Otro' })).body.error.code,
    ).toBe('ROLE_LOCKED');
    expect((await api().delete(`/api/v1/roles/${id}`).set(church.headers)).body.error.code).toBe(
      'ROLE_LOCKED',
    );
    const matrix = await api()
      .put('/api/v1/roles/matrix')
      .set(church.headers)
      .send({ grants: { [id]: {} } });
    expect(matrix.body.error.code).toBe('ROLE_LOCKED');
  });

  it('guardar la matriz cambia los permisos efectivos al instante', async () => {
    const church = await provisionChurch();
    const member = await addUser(church.headers, [church.roleId('member')]);
    await prisma.user.update({ where: { id: member.body.user.id }, data: { mustChangePassword: false } });
    const session = await loginAs({ email: member.body.user.email, password: member.body.temporaryPassword });
    const asMember = bearer(session.accessToken);
    expect((await api().post('/api/v1/campuses').set(asMember).send({ name: 'Anexo' })).status).toBe(403);

    const matrix = await api().get('/api/v1/roles/matrix').set(church.headers);
    const memberRole = matrix.body.roles.find((r: { systemKey: string }) => r.systemKey === 'member');
    const saved = await api()
      .put('/api/v1/roles/matrix')
      .set(church.headers)
      .send({ grants: { [memberRole.id]: { ...memberRole.grants, 'estructura.gestionar': 'all' } } });
    expect(saved.status).toBe(200);

    expect((await api().post('/api/v1/campuses').set(asMember).send({ name: 'Anexo' })).status).toBe(201);
    expect(await prisma.auditLog.count({ where: { action: 'roles.matrix.update' } })).toBe(1);
  });

  it('no toca roles de otra cuenta', async () => {
    const church = await provisionChurch();
    const other = await provisionChurch();
    const foreign = other.roleId('pastor');
    expect((await api().get(`/api/v1/roles/${foreign}`).set(church.headers)).status).toBe(404);
    expect(
      (await api().patch(`/api/v1/roles/${foreign}`).set(church.headers).send({ name: 'Hackeado' })).status,
    ).toBe(404);
    const matrix = await api()
      .put('/api/v1/roles/matrix')
      .set(church.headers)
      .send({ grants: { [foreign]: { 'finanzas.ver': 'all' } } });
    expect(matrix.body.error.code).toBe('ROLE_INVALID');
  });
});

describe('configuración de la cuenta', () => {
  it('datos fiscales solo para quien configura la cuenta', async () => {
    const church = await provisionChurch();
    await api()
      .patch('/api/v1/account')
      .set(church.headers)
      .send({ taxId: '30-71234567-8', primaryColor: 'teal' });
    const member = await actor({}, church.accountId);
    const asMember = await api().get('/api/v1/account').set(member.headers);
    expect(asMember.body).toMatchObject({ primaryColor: 'teal' });
    expect(asMember.body).not.toHaveProperty('taxId');
    const asOwner = await api().get('/api/v1/account').set(church.headers);
    expect(asOwner.body.taxId).toBe('30-71234567-8');
  });

  it('valida y no permite tocar límites ni estado', async () => {
    const church = await provisionChurch();
    expect(
      (await api().patch('/api/v1/account').set(church.headers).send({ primaryColor: '#ff0000' })).status,
    ).toBe(400);
    expect((await api().patch('/api/v1/account').set(church.headers).send({ userLimit: 999 })).status).toBe(
      400,
    );
    expect((await api().patch('/api/v1/account').set(church.headers).send({ status: 'active' })).status).toBe(
      400,
    );
    const labels = await api()
      .patch('/api/v1/account')
      .set(church.headers)
      .send({ structureLabels: { network: 'Distrito', zone: 'Sector' }, defaultLocale: 'pt' });
    expect(labels.body).toMatchObject({
      structureLabels: { network: 'Distrito', zone: 'Sector' },
      defaultLocale: 'pt',
    });
  });

  it('informa el uso del plan', async () => {
    const church = await provisionChurch();
    const usage = await api().get('/api/v1/account/usage').set(church.headers);
    expect(usage.body).toMatchObject({ activeUsers: 1, userLimit: 10, storageLimitMb: 50, storageUsedMb: 0 });
  });
});

describe('logo y archivos', () => {
  const png = (w = 1200, h = 600) =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#3b5f94' } })
      .png()
      .toBuffer();

  it('sube el logo como webp reducido, lo sirve y reemplaza el anterior liberando cuota', async () => {
    const church = await provisionChurch();
    const up = await api()
      .post('/api/v1/account/logo')
      .set(church.headers)
      .attach('file', await png(), 'logo.png');
    expect(up.status).toBe(201);
    const fileId = up.body.logoFileId;

    const member = await actor({}, church.accountId);
    const file = await api().get(`/api/v1/files/${fileId}`).set(member.headers);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    // Abierto directo en el navegador no puede ejecutar nada en el origen de la API.
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    const meta = await sharp(file.body as Buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);

    const used = (await prisma.account.findUniqueOrThrow({ where: { id: church.accountId } }))
      .storageUsedBytes;
    expect(Number(used)).toBe(Number(file.headers['content-length']));

    const second = await api()
      .post('/api/v1/account/logo')
      .set(church.headers)
      .attach('file', await png(300, 300), 'nuevo.png');
    expect((await api().get(`/api/v1/files/${fileId}`).set(church.headers)).status).toBe(404);
    const after = (await prisma.account.findUniqueOrThrow({ where: { id: church.accountId } }))
      .storageUsedBytes;
    const secondFile = await prisma.fileObject.findUniqueOrThrow({ where: { id: second.body.logoFileId } });
    expect(Number(after)).toBe(secondFile.sizeBytes);
  });

  it('rechaza archivos que no son imágenes aunque digan .png, y respeta la cuota', async () => {
    const church = await provisionChurch();
    const fake = await api()
      .post('/api/v1/account/logo')
      .set(church.headers)
      .attach('file', Buffer.from('<svg onload="alert(1)"></svg>'), {
        filename: 'logo.png',
        contentType: 'image/png',
      });
    expect(fake.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');

    await prisma.account.update({ where: { id: church.accountId }, data: { storageLimitMb: 0 } });
    const full = await api()
      .post('/api/v1/account/logo')
      .set(church.headers)
      .attach('file', await png(), 'logo.png');
    expect(full.body.error.code).toBe('STORAGE_LIMIT_REACHED');
    expect(await prisma.fileObject.count()).toBe(0);
  });

  it('otra cuenta no puede descargar el archivo', async () => {
    const church = await provisionChurch();
    const up = await api()
      .post('/api/v1/account/logo')
      .set(church.headers)
      .attach('file', await png(), 'logo.png');
    const other = await provisionChurch();
    expect((await api().get(`/api/v1/files/${up.body.logoFileId}`).set(other.headers)).status).toBe(404);
  });
});

describe('auditoría de la cuenta', () => {
  it('muestra solo eventos propios, con usuario, y marca las sesiones de soporte', async () => {
    const church = await provisionChurch();
    const other = await provisionChurch();
    await addUser(church.headers);
    await addUser(other.headers);

    const admin = await platformAdmin();
    const start = await api()
      .post('/api/v1/platform/impersonate')
      .set(admin.headers)
      .send({ userId: church.ownerId, reason: 'Soporte programado' });
    await api().post('/api/v1/campuses').set(bearer(start.body.accessToken)).send({ name: 'Por soporte' });

    const res = await api().get('/api/v1/audit').set(church.headers);
    expect(res.status).toBe(200);
    const actions = res.body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['users.create', 'platform.impersonation.start', 'structure.campus.create']),
    );
    expect(
      res.body.items.every((i: { user: { id: number } | null }) => !i.user || i.user.id !== admin.user.id),
    ).toBe(true);

    const campus = res.body.items.find((i: { action: string }) => i.action === 'structure.campus.create');
    expect(campus).toMatchObject({ support: true, user: { id: church.ownerId } });
    const create = res.body.items.find((i: { action: string }) => i.action === 'users.create');
    expect(create.support).toBe(false);

    const otherActions = (await api().get('/api/v1/audit').set(other.headers)).body.items.map(
      (i: { action: string }) => i.action,
    );
    expect(otherActions).not.toContain('platform.impersonation.start');
  });

  it('requiere auditoria.ver', async () => {
    const church = await provisionChurch();
    const member = await actor({ 'usuarios.ver': 'all' }, church.accountId);
    expect((await api().get('/api/v1/audit').set(member.headers)).status).toBe(403);
    const auditor = await actor({ 'auditoria.ver': 'all' }, church.accountId);
    expect((await api().get('/api/v1/audit').set(auditor.headers)).status).toBe(200);
  });
});
