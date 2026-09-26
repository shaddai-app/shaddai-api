import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { routeRegistry } from '../../src/core/http/secure-router.js';
import { PERMISSIONS } from '../../src/core/rbac/catalog.js';
import { resolvePermissions } from '../../src/core/rbac/resolve.js';
import {
  actor,
  app,
  bearer,
  createAccount,
  createUser,
  grantRole,
  loginAs,
  platformAdmin,
  prisma,
  resetDb,
} from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

/** '/campuses/:id' -> '/campuses/999999' */
const concrete = (path: string) => `/api/v1${path.replace(/:\w+/g, '999999')}`;

function call(method: string, path: string, headers: Record<string, string> = {}) {
  const r = request(app);
  const req =
    method === 'get'
      ? r.get(path)
      : method === 'post'
        ? r.post(path)
        : method === 'put'
          ? r.put(path)
          : method === 'patch'
            ? r.patch(path)
            : r.delete(path);
  return req.set(headers).send({});
}

describe('toda ruta registrada está protegida', () => {
  it('hay rutas registradas', () => {
    expect(routeRegistry.length).toBeGreaterThan(0);
  });

  it.each(routeRegistry.map((r) => [r.method.toUpperCase(), r.path, r]))(
    '%s %s sin token → 401',
    async (_m, _p, route) => {
      const res = await call(route.method, concrete(route.path));
      expect(res.status).toBe(401);
    },
  );

  it('un usuario sin permisos recibe 403 PERMISSION_DENIED en cada ruta con permiso', async () => {
    const nobody = await actor();
    const guarded = routeRegistry.filter((r) => r.scope === 'tenant' && r.access !== 'account-user');
    for (const route of guarded) {
      const res = await call(route.method, concrete(route.path), nobody.headers);
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.body.error.code, `${route.method} ${route.path}`).toBe('PERMISSION_DENIED');
    }
  });

  it('el superadmin no usa rutas de cuenta (403 ACCOUNT_USER_REQUIRED)', async () => {
    const admin = await platformAdmin();
    for (const route of routeRegistry.filter((r) => r.scope === 'tenant')) {
      const res = await call(route.method, concrete(route.path), admin.headers);
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_USER_REQUIRED');
    }
  });

  it('un usuario de cuenta, aun con todos los permisos, no entra a rutas de plataforma', async () => {
    const account = await createAccount();
    const user = await createUser({ accountId: account.id });
    await grantRole(user, {}, { systemKey: 'admin', isLocked: true });
    const { accessToken } = await loginAs(user);
    const platformRoutes = routeRegistry.filter((r) => r.scope === 'platform');
    expect(platformRoutes.length).toBeGreaterThan(0);
    for (const route of platformRoutes) {
      const res = await call(route.method, concrete(route.path), bearer(accessToken));
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.body.error.code).toBe('PLATFORM_ADMIN_REQUIRED');
    }
  });

  it('un superadmin sin 2FA enrolado no entra a rutas de plataforma', async () => {
    const admin = await createUser({ isPlatformAdmin: true });
    const { accessToken } = await loginAs(admin);
    const res = await call('get', '/api/v1/platform/accounts', bearer(accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TOTP_ENROLLMENT_REQUIRED');
  });
});

describe('cuenta en solo lectura', () => {
  it('morosa: puede leer pero no escribir', async () => {
    const account = await createAccount({ status: 'past_due' });
    const user = await createUser({ accountId: account.id });
    await grantRole(user, { 'estructura.gestionar': 'all' });
    const { accessToken } = await loginAs(user);
    expect((await request(app).get('/api/v1/campuses').set(bearer(accessToken))).status).toBe(200);
    const write = await request(app).post('/api/v1/campuses').set(bearer(accessToken)).send({ name: 'x' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('ACCOUNT_READ_ONLY');
  });

  it('prueba vencida: solo lectura; prueba vigente: escritura normal', async () => {
    const expired = await createAccount({ status: 'trial' });
    await prisma.account.update({
      where: { id: expired.id },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });
    const a = await actor({ 'estructura.gestionar': 'all' }, expired.id);
    expect(
      (await request(app).post('/api/v1/campuses').set(a.headers).send({ name: 'x' })).body.error.code,
    ).toBe('ACCOUNT_READ_ONLY');

    const active = await createAccount({ status: 'trial' });
    await prisma.account.update({
      where: { id: active.id },
      data: { trialEndsAt: new Date(Date.now() + 86_400_000) },
    });
    const b = await actor({ 'estructura.gestionar': 'all' }, active.id);
    expect((await request(app).post('/api/v1/campuses').set(b.headers).send({ name: 'x' })).status).toBe(201);
  });
});

describe('resolución de permisos', () => {
  it('une roles y "all" gana sobre "own"', async () => {
    const account = await createAccount();
    const user = await createUser({ accountId: account.id });
    await grantRole(user, { 'celulas.ver': 'own', 'personas.ver': 'own' });
    await grantRole(user, { 'celulas.ver': 'all' });
    expect(await resolvePermissions(user.id)).toEqual({ 'celulas.ver': 'all', 'personas.ver': 'own' });
  });

  it('el rol Administrador bloqueado tiene todos los permisos del catálogo', async () => {
    const account = await createAccount();
    const user = await createUser({ accountId: account.id });
    await grantRole(user, {}, { systemKey: 'admin', isLocked: true });
    const perms = await resolvePermissions(user.id);
    expect(Object.keys(perms)).toHaveLength(PERMISSIONS.length);
    expect(Object.values(perms).every((s) => s === 'all')).toBe(true);
  });

  it('/me devuelve los permisos efectivos', async () => {
    const a = await actor({ 'finanzas.ver': 'all', 'celulas.reportar': 'own' });
    const me = await request(app).get('/api/v1/me').set(a.headers);
    expect(me.body.permissions).toEqual({ 'finanzas.ver': 'all', 'celulas.reportar': 'own' });
  });

  it('quitar un rol se refleja al invalidar el caché', async () => {
    const a = await actor({ 'estructura.gestionar': 'all' });
    expect((await request(app).post('/api/v1/campuses').set(a.headers).send({ name: 'x' })).status).toBe(201);
    await prisma.userRole.deleteMany({ where: { userId: a.user.id } });
    const { invalidateUserPermissions } = await import('../../src/core/rbac/permission-cache.js');
    invalidateUserPermissions(a.user.id);
    expect((await request(app).post('/api/v1/campuses').set(a.headers).send({ name: 'y' })).status).toBe(403);
  });
});
