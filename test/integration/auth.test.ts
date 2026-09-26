import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import {
  app,
  bearer,
  createAccount,
  createAccountUser,
  createUser,
  csrf,
  loginAs,
  NEW_STRONG_PASSWORD,
  prisma,
  refreshCookieFrom,
  resetDb,
} from './helpers.js';

const api = () => request(app);

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('login', () => {
  it('emite access token, cookie httpOnly de refresh y permite /me', async () => {
    const user = await createAccountUser();
    const res = await api().post('/api/v1/auth/login').send({ email: user.email, password: user.password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.restriction).toBeNull();
    expect(res.body).not.toHaveProperty('refreshToken');
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('sh_rt='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
    expect(res.headers['cache-control']).toBe('no-store');

    const me = await api().get('/api/v1/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(user.email);
    expect(me.body.account.name).toBe('Iglesia Test');
  });

  it('acepta el email con mayúsculas y espacios', async () => {
    const user = await createAccountUser();
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: `  ${user.email.toUpperCase()} `, password: user.password });
    expect(res.status).toBe(200);
  });

  it('responde igual para contraseña incorrecta y email inexistente', async () => {
    const user = await createAccountUser();
    const wrong = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'no-es-esta' });
    const unknown = await api().post('/api/v1/auth/login').send({ email: 'nadie@test.local', password: 'x' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(unknown.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('bloquea tras 5 intentos fallidos, incluso con la contraseña correcta', async () => {
    const user = await createAccountUser();
    for (let i = 0; i < 4; i++) {
      const res = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'mal' });
      expect(res.status).toBe(401);
    }
    const fifth = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'mal' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.details.retryAfterSeconds).toBeGreaterThan(800);

    const correct = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });
    expect(correct.status).toBe(423);
    expect(await prisma.auditLog.count({ where: { action: 'auth.lockout', userId: user.id } })).toBe(1);
  });

  it('rechaza usuarios inactivos y cuentas suspendidas', async () => {
    const inactive = await createAccountUser({ isActive: false });
    const r1 = await api()
      .post('/api/v1/auth/login')
      .send({ email: inactive.email, password: inactive.password });
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('USER_INACTIVE');

    const suspended = await createAccount({ status: 'suspended' });
    const user = await createUser({ accountId: suspended.id });
    const r2 = await api().post('/api/v1/auth/login').send({ email: user.email, password: user.password });
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('suspender la cuenta corta las sesiones ya abiertas', async () => {
    const user = await createAccountUser();
    const { accessToken } = await loginAs(user);
    await prisma.account.update({ where: { id: user.accountId! }, data: { status: 'suspended' } });
    const res = await api().get('/api/v1/me').set(bearer(accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('primer ingreso (MustChangePassword)', () => {
  it('solo permite cambiar la contraseña hasta hacerlo', async () => {
    const user = await createAccountUser({ mustChangePassword: true });
    const { accessToken, body } = await loginAs(user);
    expect(body.restriction).toBe('password_change');

    // /me responde (el front lo usa para redirigir), el resto no.
    expect((await api().get('/api/v1/me').set(bearer(accessToken))).body.restriction).toBe('password_change');
    const blocked = await api().get('/api/v1/me/sessions').set(bearer(accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(accessToken))
      .send({ currentPassword: user.password, newPassword: 'password12' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('PASSWORD_TOO_WEAK');

    const ok = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(accessToken))
      .send({ currentPassword: user.password, newPassword: NEW_STRONG_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.restriction).toBeNull();

    // El access token viejo quedó invalidado; el nuevo tiene acceso completo.
    expect((await api().get('/api/v1/me').set(bearer(accessToken))).status).toBe(401);
    expect((await api().get('/api/v1/me/sessions').set(bearer(ok.body.accessToken))).status).toBe(200);
  });

  it('rechaza contraseña actual incorrecta y repetir la misma', async () => {
    const user = await createAccountUser({ mustChangePassword: true });
    const { accessToken } = await loginAs(user);
    const wrong = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(accessToken))
      .send({ currentPassword: 'otra', newPassword: NEW_STRONG_PASSWORD });
    expect(wrong.body.error.code).toBe('PASSWORD_CURRENT_INVALID');
    const same = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(accessToken))
      .send({ currentPassword: user.password, newPassword: user.password });
    expect(same.body.error.code).toBe('PASSWORD_SAME_AS_CURRENT');
  });
});

describe('refresh', () => {
  it('rota el token y emite uno nuevo', async () => {
    const user = await createAccountUser();
    const { cookie } = await loginAs(user);
    const res = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(refreshCookieFrom(res)).not.toBe(cookie);
  });

  it('exige el header anti-CSRF y un Origin conocido', async () => {
    const user = await createAccountUser();
    const { cookie } = await loginAs(user);
    const noHeader = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF_HEADER_MISSING');
    const badOrigin = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set(csrf)
      .set('Origin', 'https://evil.example');
    expect(badOrigin.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('reusar un token rotado dentro de la ventana de gracia no revoca la sesión (carrera de pestañas)', async () => {
    const user = await createAccountUser();
    const { cookie } = await loginAs(user);
    const first = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf);
    const race = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf);
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe('AUTH_REFRESH_RACE');
    const next = await api().post('/api/v1/auth/refresh').set('Cookie', refreshCookieFrom(first)).set(csrf);
    expect(next.status).toBe(200);
  });

  it('reusar un token rotado fuera de la gracia revoca toda la familia', async () => {
    const user = await createAccountUser();
    const { cookie, accessToken } = await loginAs(user);
    const first = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf);
    // Simula que el reuso ocurre un minuto después de la rotación.
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedReason: 'rotated' },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    const reuse = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('AUTH_REFRESH_REUSED');

    // El token legítimo más nuevo y los access tokens de esa sesión también quedan inválidos.
    expect(
      (await api().post('/api/v1/auth/refresh').set('Cookie', refreshCookieFrom(first)).set(csrf)).status,
    ).toBe(401);
    expect((await api().get('/api/v1/me').set(bearer(accessToken))).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected' } })).toBe(1);
  });

  it('"Recordarme" extiende la vida del refresh', async () => {
    const user = await createAccountUser();
    await loginAs(user, true);
    const token = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
    const days = (token.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
  });
});

describe('logout y sesiones', () => {
  it('logout invalida refresh y access de esa sesión', async () => {
    const user = await createAccountUser();
    const { cookie, accessToken } = await loginAs(user);
    const out = await api().post('/api/v1/auth/logout').set('Cookie', cookie).set(csrf);
    expect(out.status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf)).status).toBe(401);
    expect((await api().get('/api/v1/me').set(bearer(accessToken))).status).toBe(401);
  });

  it('lista sesiones y permite cerrar otra', async () => {
    const user = await createAccountUser();
    const a = await loginAs(user);
    const b = await loginAs(user);
    const list = await api().get('/api/v1/me/sessions').set(bearer(a.accessToken));
    expect(list.body.items).toHaveLength(2);
    const other = list.body.items.find((s: { current: boolean }) => !s.current);

    expect((await api().delete(`/api/v1/me/sessions/${other.id}`).set(bearer(a.accessToken))).status).toBe(
      204,
    );
    expect((await api().get('/api/v1/me').set(bearer(b.accessToken))).status).toBe(401);
    expect((await api().get('/api/v1/me').set(bearer(a.accessToken))).status).toBe(200);
  });

  it('no permite cerrar sesiones de otro usuario', async () => {
    const alice = await createAccountUser();
    const bob = await createAccountUser();
    const a = await loginAs(alice);
    const b = await loginAs(bob);
    const bobSessions = await api().get('/api/v1/me/sessions').set(bearer(b.accessToken));
    const res = await api()
      .delete(`/api/v1/me/sessions/${bobSessions.body.items[0].id}`)
      .set(bearer(a.accessToken));
    expect(res.status).toBe(404);
    expect((await api().get('/api/v1/me').set(bearer(b.accessToken))).status).toBe(200);
  });

  it('logout-all cierra todas las sesiones', async () => {
    const user = await createAccountUser();
    const a = await loginAs(user);
    const b = await loginAs(user);
    expect((await api().post('/api/v1/auth/logout-all').set(bearer(a.accessToken))).status).toBe(204);
    expect((await api().get('/api/v1/me').set(bearer(a.accessToken))).status).toBe(401);
    expect((await api().get('/api/v1/me').set(bearer(b.accessToken))).status).toBe(401);
  });
});

describe('olvidé mi contraseña', () => {
  it('manda un enlace de un solo uso que permite restablecerla', async () => {
    const user = await createAccountUser();
    const { accessToken } = await loginAs(user);

    const forgot = await api().post('/api/v1/auth/forgot').send({ email: user.email });
    expect(forgot.status).toBe(202);
    expect(memoryOutbox).toHaveLength(1);
    const token = new URL(memoryOutbox[0]!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    const reset = await api().post('/api/v1/auth/reset').send({ token, newPassword: NEW_STRONG_PASSWORD });
    expect(reset.status).toBe(204);

    // Cierra sesiones previas; la nueva contraseña funciona; el enlace no se reusa.
    expect((await api().get('/api/v1/me').set(bearer(accessToken))).status).toBe(401);
    await loginAs({ email: user.email, password: NEW_STRONG_PASSWORD });
    const again = await api()
      .post('/api/v1/auth/reset')
      .send({ token, newPassword: 'otra-frase-muy-segura-123' });
    expect(again.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('no revela si el email existe', async () => {
    const res = await api().post('/api/v1/auth/forgot').send({ email: 'nadie@test.local' });
    expect(res.status).toBe(202);
    expect(memoryOutbox).toHaveLength(0);
  });
});

describe('superadmin y 2FA', () => {
  it('exige enrolar TOTP antes de usar la plataforma y luego lo pide en cada login', async () => {
    const admin = await createUser({ isPlatformAdmin: true });
    const first = await loginAs(admin);
    expect(first.body.restriction).toBe('totp_enroll');
    expect((await api().get('/api/v1/me/sessions').set(bearer(first.accessToken))).body.error.code).toBe(
      'TOTP_ENROLLMENT_REQUIRED',
    );

    const enroll = await api().post('/api/v1/auth/2fa/enroll').set(bearer(first.accessToken));
    expect(enroll.status).toBe(200);
    expect(enroll.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = enroll.body.secret as string;

    const bad = await api()
      .post('/api/v1/auth/2fa/confirm')
      .set(bearer(first.accessToken))
      .send({ code: '000000' });
    expect(bad.status).toBe(400);
    const ok = await api()
      .post('/api/v1/auth/2fa/confirm')
      .set(bearer(first.accessToken))
      .send({ code: await generate({ secret }) });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/v1/me/sessions').set(bearer(ok.body.accessToken))).status).toBe(200);

    // Login siguiente: primero challenge, después el código.
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect(login.body).toEqual({ requires2fa: true, challengeToken: expect.any(String) });
    expect(login.headers['set-cookie']).toBeUndefined();

    const wrong = await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challengeToken: login.body.challengeToken, code: '123456' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('AUTH_INVALID_CODE');

    const verified = await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challengeToken: login.body.challengeToken, code: await generate({ secret }) });
    expect(verified.status).toBe(200);
    expect(verified.body.restriction).toBeNull();
  });

  it('el secreto TOTP se guarda cifrado', async () => {
    const admin = await createUser({ isPlatformAdmin: true });
    const { accessToken } = await loginAs(admin);
    const { body } = await api().post('/api/v1/auth/2fa/enroll').set(bearer(accessToken));
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(stored.totpSecretEnc).toMatch(/^v1:/);
    expect(stored.totpSecretEnc).not.toContain(body.secret);
  });

  it('un challenge 2FA no sirve como access token', async () => {
    const admin = await createUser({ isPlatformAdmin: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    const res = await api().get('/api/v1/me').set(bearer(login.body.challengeToken));
    expect(res.status).toBe(401);
  });
});

describe('/me', () => {
  it('actualiza idioma y tema, y rechaza campos no permitidos', async () => {
    const user = await createAccountUser();
    const { accessToken } = await loginAs(user);
    const ok = await api().patch('/api/v1/me').set(bearer(accessToken)).send({ locale: 'pt', theme: 'dark' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ locale: 'pt', theme: 'dark' });

    const bad = await api().patch('/api/v1/me').set(bearer(accessToken)).send({ isPlatformAdmin: true });
    expect(bad.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isPlatformAdmin).toBe(false);
  });

  it('sin token responde 401', async () => {
    expect((await api().get('/api/v1/me')).status).toBe(401);
    expect((await api().get('/api/v1/me').set(bearer('basura'))).status).toBe(401);
  });
});
