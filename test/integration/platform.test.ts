import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import { PERMISSIONS } from '../../src/core/rbac/catalog.js';
import { DEFAULT_ROLES } from '../../src/core/rbac/default-roles.js';
import { resolvePermissions } from '../../src/core/rbac/resolve.js';
import { DEFAULT_CATALOGS } from '../../src/modules/platform/account-template.js';
import { slugify } from '../../src/modules/platform/platform.service.js';
import {
  actor,
  app,
  bearer,
  createAccountUser,
  createUser,
  loginAs,
  NEW_STRONG_PASSWORD,
  platformAdmin,
  prisma,
  resetDb,
} from './helpers.js';

const api = () => request(app);

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function createPlan(overrides: Record<string, unknown> = {}) {
  return prisma.plan.create({
    data: {
      code: 'standard',
      name: 'Estándar',
      userLimit: 15,
      storageLimitMb: 5120,
      priceUsd: '35',
      ...overrides,
    },
  });
}

async function newChurch(headers: Record<string, string>, overrides: Record<string, unknown> = {}) {
  const plan = await createPlan();
  const res = await api()
    .post('/api/v1/platform/accounts')
    .set(headers)
    .send({
      name: 'Iglesia Evangélica Monte Sión',
      planId: plan.id,
      admin: { email: 'Pastor@MonteSion.org', firstName: 'Juan', lastName: 'Pérez' },
      ...overrides,
    });
  return { res, plan };
}

describe('alta de cuenta', () => {
  it('crea cuenta, sede principal, roles, catálogos y admin con contraseña de un solo uso', async () => {
    const admin = await platformAdmin();
    const { res, plan } = await newChurch(admin.headers);

    expect(res.status).toBe(201);
    const { account, temporaryPassword } = res.body;
    expect(account).toMatchObject({
      name: 'Iglesia Evangélica Monte Sión',
      slug: 'iglesia-evangelica-monte-sion',
      status: 'trial',
      userLimit: plan.userLimit,
      defaultLocale: 'es',
      currency: 'ARS',
    });
    expect(new Date(account.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(account.usage).toMatchObject({ activeUsers: 1, userLimit: 15 });
    expect(temporaryPassword).toMatch(/^[A-Za-z2-9]{16}$/);

    const id = account.id as number;
    expect(await prisma.campus.findMany({ where: { accountId: id } })).toMatchObject([
      { name: 'Sede principal', isMain: true },
    ]);
    const roles = await prisma.role.findMany({ where: { accountId: id } });
    expect(roles.map((r) => r.systemKey).sort()).toEqual(DEFAULT_ROLES.map((r) => r.systemKey).sort());
    expect(roles.find((r) => r.systemKey === 'admin')).toMatchObject({
      name: 'Administrador',
      isLocked: true,
    });
    const catalogCount = Object.values(DEFAULT_CATALOGS).flat().length;
    expect(await prisma.catalogItem.count({ where: { accountId: id } })).toBe(catalogCount);

    // El admin (email normalizado) entra con la temporal y queda obligado a cambiarla.
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'pastor@montesion.org' } });
    expect(owner).toMatchObject({ accountId: id, isAccountOwner: true, mustChangePassword: true });
    const login = await loginAs({ email: 'pastor@montesion.org', password: temporaryPassword });
    expect(login.body.restriction).toBe('password_change');
    expect(Object.keys(await resolvePermissions(owner.id))).toHaveLength(PERMISSIONS.length);

    // La contraseña temporal nunca queda en la auditoría.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'platform.account.create' } });
    expect(log.after).not.toContain(temporaryPassword);
    expect(log.accountId).toBe(id);
  });

  it('respeta el idioma de la cuenta en los nombres por defecto', async () => {
    const admin = await platformAdmin();
    const { res } = await newChurch(admin.headers, { defaultLocale: 'pt', status: 'active' });
    expect(res.body.account.trialEndsAt).toBeNull();
    const roles = await prisma.role.findMany({ where: { accountId: res.body.account.id } });
    expect(roles.find((r) => r.systemKey === 'treasurer')?.name).toBe('Tesoureiro');
  });

  it('los permisos sin alcance "own" se guardan como "all" en los roles por defecto', async () => {
    const admin = await platformAdmin();
    const { res } = await newChurch(admin.headers);
    const leader = await prisma.role.findFirstOrThrow({
      where: { accountId: res.body.account.id, systemKey: 'supervisor' },
      include: { permissions: { include: { permission: true } } },
    });
    const byKey = Object.fromEntries(leader.permissions.map((p) => [p.permission.key, p.scope]));
    expect(byKey['celulas.reportar']).toBe('own'); // admite alcance
    expect(byKey['personas.crear']).toBe('all'); // no admite alcance
    expect(byKey['eventos.ver']).toBe('all');
  });

  it('genera slugs únicos y rechaza emails ya usados', async () => {
    const admin = await platformAdmin();
    const { plan } = await newChurch(admin.headers);
    const second = await api()
      .post('/api/v1/platform/accounts')
      .set(admin.headers)
      .send({
        name: 'Iglesia Evangélica Monte Sión',
        planId: plan.id,
        admin: { email: 'otro@montesion.org', firstName: 'A', lastName: 'B' },
      });
    expect(second.body.account.slug).toBe('iglesia-evangelica-monte-sion-2');

    const dup = await api()
      .post('/api/v1/platform/accounts')
      .set(admin.headers)
      .send({
        name: 'Otra',
        planId: plan.id,
        admin: { email: 'pastor@montesion.org', firstName: 'A', lastName: 'B' },
      });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');
  });

  it('es atómica: si falla a mitad no deja nada creado', async () => {
    const admin = await platformAdmin();
    const plan = await createPlan();
    // Sin permisos sembrados, la plantilla falla después de crear la cuenta.
    await prisma.rolePermission.deleteMany();
    await prisma.permission.deleteMany();
    const res = await api()
      .post('/api/v1/platform/accounts')
      .set(admin.headers)
      .send({ name: 'Rota', planId: plan.id, admin: { email: 'x@rota.org', firstName: 'A', lastName: 'B' } });
    expect(res.status).toBe(500);
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.user.count({ where: { email: 'x@rota.org' } })).toBe(0);
    // Restaura el catálogo para los demás tests.
    const { seedPermissions } = await import('../../prisma/seed/permissions.js');
    await seedPermissions(prisma);
  });

  it('envía el acceso por mail si se pide', async () => {
    const admin = await platformAdmin();
    const { res } = await newChurch(admin.headers, { sendAccessEmail: true });
    expect(memoryOutbox).toHaveLength(1);
    expect(memoryOutbox[0]).toMatchObject({ to: 'pastor@montesion.org' });
    expect(memoryOutbox[0]!.text).toContain(res.body.temporaryPassword);
  });

  it('valida la entrada', async () => {
    const admin = await platformAdmin();
    const plan = await createPlan();
    const bad = await api()
      .post('/api/v1/platform/accounts')
      .set(admin.headers)
      .send({
        name: 'X',
        planId: plan.id,
        admin: { email: 'no-es-email', firstName: '', lastName: 'B' },
        extra: 1,
      });
    expect(bad.status).toBe(400);
    const inactivePlan = await prisma.plan.update({ where: { id: plan.id }, data: { isActive: false } });
    const res = await api()
      .post('/api/v1/platform/accounts')
      .set(admin.headers)
      .send({
        name: 'Iglesia',
        planId: inactivePlan.id,
        admin: { email: 'a@b.org', firstName: 'A', lastName: 'B' },
      });
    expect(res.body.error.code).toBe('PLAN_INVALID');
  });
});

describe('gestión de cuentas', () => {
  it('lista con filtros y cuenta usuarios activos', async () => {
    const admin = await platformAdmin();
    await newChurch(admin.headers);
    const list = await api().get('/api/v1/platform/accounts?q=monte&status=trial').set(admin.headers);
    expect(list.body).toMatchObject({ total: 1, page: 1 });
    expect(list.body.items[0]).toMatchObject({ slug: 'iglesia-evangelica-monte-sion', activeUsers: 1 });
    const none = await api().get('/api/v1/platform/accounts?status=suspended').set(admin.headers);
    expect(none.body.total).toBe(0);
  });

  it('edita límites y datos, y audita el antes/después', async () => {
    const admin = await platformAdmin();
    const { res } = await newChurch(admin.headers);
    const id = res.body.account.id;
    const upd = await api()
      .patch(`/api/v1/platform/accounts/${id}`)
      .set(admin.headers)
      .send({ userLimit: 30, taxId: '30-12345678-9', notes: 'Pagó por transferencia' });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ userLimit: 30, taxId: '30-12345678-9' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'platform.account.update' } });
    expect(JSON.parse(log.after!)).toMatchObject({ userLimit: { from: 15, to: 30 } });

    expect(
      (await api().patch(`/api/v1/platform/accounts/${id}`).set(admin.headers).send({ userLimit: 0 })).status,
    ).toBe(400);
    expect(
      (await api().patch(`/api/v1/platform/accounts/${id}`).set(admin.headers).send({ taxId: '123' })).status,
    ).toBe(400);
  });

  it('suspender corta el acceso de la cuenta; reactivar lo devuelve', async () => {
    const admin = await platformAdmin();
    const member = await createAccountUser();
    const session = await loginAs(member);

    const suspend = await api()
      .post(`/api/v1/platform/accounts/${member.accountId}/status`)
      .set(admin.headers)
      .send({ status: 'suspended', reason: 'Falta de pago' });
    expect(suspend.body.status).toBe('suspended');
    expect((await api().get('/api/v1/me').set(bearer(session.accessToken))).body.error.code).toBe(
      'ACCOUNT_SUSPENDED',
    );
    expect(await prisma.refreshToken.count({ where: { userId: member.id, revokedAt: null } })).toBe(0);

    await api()
      .post(`/api/v1/platform/accounts/${member.accountId}/status`)
      .set(admin.headers)
      .send({ status: 'active', reason: 'Regularizó' });
    await loginAs(member);
  });

  it('cerrar la cuenta programa la purga a 90 días y exige motivo', async () => {
    const admin = await platformAdmin();
    const member = await createAccountUser();
    const noReason = await api()
      .post(`/api/v1/platform/accounts/${member.accountId}/status`)
      .set(admin.headers)
      .send({ status: 'closed' });
    expect(noReason.status).toBe(400);
    const res = await api()
      .post(`/api/v1/platform/accounts/${member.accountId}/status`)
      .set(admin.headers)
      .send({ status: 'closed', reason: 'Baja solicitada' });
    const days = (new Date(res.body.purgeAfter).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('resetea la contraseña del admin: desbloquea, obliga a cambiarla y cierra sesiones', async () => {
    const admin = await platformAdmin();
    const { res } = await newChurch(admin.headers);
    const owner = res.body.account.admins[0];
    const first = await loginAs({ email: owner.email, password: res.body.temporaryPassword });
    const changed = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(first.accessToken))
      .send({ currentPassword: res.body.temporaryPassword, newPassword: NEW_STRONG_PASSWORD });
    await prisma.user.update({
      where: { id: owner.id },
      data: { lockedUntil: new Date(Date.now() + 3_600_000) },
    });

    const reset = await api()
      .post(`/api/v1/platform/accounts/${res.body.account.id}/admins/${owner.id}/reset-password`)
      .set(admin.headers)
      .send({});
    expect(reset.status).toBe(200);
    expect(reset.body.temporaryPassword).not.toBe(res.body.temporaryPassword);

    expect((await api().get('/api/v1/me').set(bearer(changed.body.accessToken))).status).toBe(401);
    const bad = await api()
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: NEW_STRONG_PASSWORD });
    expect(bad.status).toBe(401);
    const again = await loginAs({ email: owner.email, password: reset.body.temporaryPassword });
    expect(again.body.restriction).toBe('password_change');
  });

  it('no resetea usuarios de otra cuenta por la URL de esta', async () => {
    const admin = await platformAdmin();
    const { res } = await newChurch(admin.headers);
    const outsider = await createAccountUser();
    const reset = await api()
      .post(`/api/v1/platform/accounts/${res.body.account.id}/admins/${outsider.id}/reset-password`)
      .set(admin.headers)
      .send({});
    expect(reset.status).toBe(404);
  });
});

describe('planes, panorama y auditoría', () => {
  it('crea y edita planes', async () => {
    const admin = await platformAdmin();
    const created = await api()
      .post('/api/v1/platform/plans')
      .set(admin.headers)
      .send({ code: 'pro', name: 'Pro', userLimit: 40, storageLimitMb: 20480, priceUsd: 70 });
    expect(created.status).toBe(201);
    const upd = await api()
      .patch(`/api/v1/platform/plans/${created.body.id}`)
      .set(admin.headers)
      .send({ priceUsd: 80 });
    expect(Number(upd.body.priceUsd)).toBe(80);
    const dup = await api()
      .post('/api/v1/platform/plans')
      .set(admin.headers)
      .send({ code: 'pro', name: 'Pro 2', userLimit: 1, storageLimitMb: 1, priceUsd: 1 });
    expect(dup.status).toBe(409);
  });

  it('stats y auditoría filtrable por cuenta', async () => {
    const admin = await platformAdmin();
    const { res } = await newChurch(admin.headers);
    const stats = await api().get('/api/v1/platform/stats').set(admin.headers);
    expect(stats.body).toMatchObject({
      accountsByStatus: { trial: 1 },
      activeUsers: 1,
      newAccountsLast30Days: 1,
    });

    const audit = await api()
      .get(`/api/v1/platform/audit?accountId=${res.body.account.id}`)
      .set(admin.headers);
    expect(audit.status).toBe(200);
    expect(audit.body.items.map((i: { action: string }) => i.action)).toContain('platform.account.create');
    expect(typeof audit.body.items[0].id).toBe('string'); // BigInt serializado
  });
});

describe('impersonación (soporte)', () => {
  it('actúa como el usuario, queda auditada y se puede terminar', async () => {
    const admin = await platformAdmin();
    const target = await actor({ 'estructura.gestionar': 'all' });

    const start = await api()
      .post('/api/v1/platform/impersonate')
      .set(admin.headers)
      .send({ userId: target.user.id, reason: 'Ticket #42: no ve sus sedes' });
    expect(start.status).toBe(200);
    const support = bearer(start.body.accessToken);

    const me = await api().get('/api/v1/me').set(support);
    expect(me.body.user.id).toBe(target.user.id);
    expect(me.body.impersonation).toEqual({ impersonatorId: admin.user.id });

    const created = await api().post('/api/v1/campuses').set(support).send({ name: 'Creada por soporte' });
    expect(created.status).toBe(201);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'structure.campus.create' } });
    expect(log).toMatchObject({
      userId: target.user.id,
      impersonatorId: admin.user.id,
      accountId: target.accountId,
    });
    expect(
      await prisma.auditLog.count({
        where: { action: 'platform.impersonation.start', accountId: target.accountId },
      }),
    ).toBe(1);

    // Nunca puede tocar la identidad del usuario.
    for (const [method, path] of [
      ['post', '/api/v1/auth/change-password'],
      ['post', '/api/v1/auth/logout-all'],
      ['post', '/api/v1/auth/2fa/enroll'],
      ['patch', '/api/v1/me'],
    ] as const) {
      const res = await api()[method](path).set(support).send({});
      expect(res.body.error.code, path).toBe('IMPERSONATION_FORBIDDEN');
    }

    expect((await api().post('/api/v1/auth/impersonation/stop').set(support)).status).toBe(204);
    expect((await api().get('/api/v1/me').set(support)).status).toBe(401);
    expect((await api().get('/api/v1/me').set(target.headers)).status).toBe(200); // su sesión propia sigue
  });

  it('funciona aunque el usuario tenga pendiente cambiar la contraseña', async () => {
    const admin = await platformAdmin();
    const target = await createAccountUser({ mustChangePassword: true });
    const start = await api()
      .post('/api/v1/platform/impersonate')
      .set(admin.headers)
      .send({ userId: target.id, reason: 'Revisión de configuración' });
    const res = await api().get('/api/v1/campuses').set(bearer(start.body.accessToken));
    expect(res.status).toBe(200);
  });

  it('exige motivo, no permite impersonar superadmins y muere si el superadmin pierde el rol', async () => {
    const admin = await platformAdmin();
    const target = await createAccountUser();
    const noReason = await api()
      .post('/api/v1/platform/impersonate')
      .set(admin.headers)
      .send({ userId: target.id });
    expect(noReason.status).toBe(400);

    const other = await createUser({ isPlatformAdmin: true });
    const bad = await api()
      .post('/api/v1/platform/impersonate')
      .set(admin.headers)
      .send({ userId: other.id, reason: 'probando límites' });
    expect(bad.body.error.code).toBe('USER_NOT_FOUND');

    const start = await api()
      .post('/api/v1/platform/impersonate')
      .set(admin.headers)
      .send({ userId: target.id, reason: 'Soporte general' });
    await prisma.user.update({ where: { id: admin.user.id }, data: { isPlatformAdmin: false } });
    expect((await api().get('/api/v1/me').set(bearer(start.body.accessToken))).status).toBe(401);
  });

  it('stop sin impersonación responde 400', async () => {
    const member = await actor();
    const res = await api().post('/api/v1/auth/impersonation/stop').set(member.headers);
    expect(res.body.error.code).toBe('NOT_IMPERSONATING');
  });
});

describe('slugify', () => {
  it('normaliza acentos, símbolos y largo', () => {
    expect(slugify('  Iglesia "Dios es Amor" — Ñuñoa!  ')).toBe('iglesia-dios-es-amor-nunoa');
    expect(slugify('¡¡¡')).toBe('iglesia');
    expect(slugify('a'.repeat(80))).toHaveLength(50);
  });
});
