import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import {
  actor,
  app,
  bearer,
  createUser,
  csrf,
  grantRole,
  loginAs,
  prisma,
  provisionChurch,
  resetDb,
  STRONG_PASSWORD,
} from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const post = (headers: Headers, path: string, body?: object) =>
  request(app).post(api(path)).set(headers).set(csrf).send(body);

/** Usuario común de una iglesia que activa la verificación en dos pasos. */
async function enrolledUser(accountId?: number) {
  const user = await actor({}, accountId);
  const enroll = await post(user.headers, '/auth/2fa/enroll');
  expect(enroll.status).toBe(200);
  const secret = enroll.body.secret as string;
  const confirm = await post(user.headers, '/auth/2fa/confirm', { code: await generate({ secret }) });
  expect(confirm.status).toBe(200);
  return {
    ...user,
    secret,
    recoveryCodes: confirm.body.recoveryCodes as string[],
    headers: bearer(confirm.body.accessToken as string),
  };
}

/** Login completo con segundo factor; devuelve la respuesta del /auth/2fa/verify. */
async function loginWith(user: { email: string; password: string }, code: string) {
  const login = await request(app)
    .post(api('/auth/login'))
    .send({ email: user.email, password: user.password });
  expect(login.body.requires2fa).toBe(true);
  return request(app).post(api('/auth/2fa/verify')).send({ challengeToken: login.body.challengeToken, code });
}

const me = async (headers: Headers) => (await request(app).get(api('/me')).set(headers)).body.user;

describe('verificación en dos pasos para cualquier usuario', () => {
  it('se activa con 10 códigos de recuperación y desde ahí el login pide el código', async () => {
    const u = await enrolledUser();
    expect(u.recoveryCodes).toHaveLength(10);
    expect(new Set(u.recoveryCodes).size).toBe(10);
    expect(await me(u.headers)).toMatchObject({ totpEnabled: true, totpRecoveryCodesLeft: 10 });
    // Solo se guardan hashes.
    const stored = await prisma.totpRecoveryCode.findMany({ where: { userId: u.user.id } });
    expect(stored.map((c) => c.codeHash)).not.toContain(u.recoveryCodes[0]);

    const ok = await loginWith(u.user, await generate({ secret: u.secret }));
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect((await loginWith(u.user, '000000')).body.error.code).toBe('AUTH_INVALID_CODE');
  });

  it('un código de recuperación entra una sola vez, como lo tipee la persona, y avisa por mail', async () => {
    const u = await enrolledUser();
    const [code] = u.recoveryCodes;
    const typed = code!.replace('-', ' ').toUpperCase();
    const first = await loginWith(u.user, typed);
    expect(first.status).toBe(200);
    expect((await loginWith(u.user, code!)).body.error.code).toBe('AUTH_INVALID_CODE');

    expect(await me(bearer(first.body.accessToken))).toMatchObject({ totpRecoveryCodesLeft: 9 });
    const mail = memoryOutbox.find((m) => m.to === u.user.email);
    expect(mail?.text).toContain('código de recuperación');
    expect(mail?.text).toContain('Te quedan 9');
    expect(
      await prisma.auditLog.count({ where: { userId: u.user.id, action: 'auth.totp.recovery_used' } }),
    ).toBe(1);
  });

  it('regenerar códigos pide la contraseña y anula los anteriores', async () => {
    const u = await enrolledUser();
    expect(
      (await post(u.headers, '/auth/2fa/recovery-codes', { password: 'no-es-la-clave' })).body.error.code,
    ).toBe('PASSWORD_CURRENT_INVALID');
    const res = await post(u.headers, '/auth/2fa/recovery-codes', { password: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    const fresh = res.body.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(u.recoveryCodes[0]);
    expect((await loginWith(u.user, u.recoveryCodes[0]!)).status).toBe(401);
    expect((await loginWith(u.user, fresh[0]!)).status).toBe(200);
  });

  it('desactivarla pide contraseña y un código; después se entra sin código y llega el aviso', async () => {
    const u = await enrolledUser();
    const body = { password: STRONG_PASSWORD, code: '000000' };
    expect((await post(u.headers, '/auth/2fa/disable', body)).body.error.code).toBe('AUTH_INVALID_CODE');
    expect(
      (await post(u.headers, '/auth/2fa/disable', { ...body, password: 'mala-mala-mala' })).body.error.code,
    ).toBe('PASSWORD_CURRENT_INVALID');

    const ok = await post(u.headers, '/auth/2fa/disable', { ...body, code: u.recoveryCodes[3] });
    expect(ok.status).toBe(204);
    expect(await prisma.totpRecoveryCode.count({ where: { userId: u.user.id } })).toBe(0);
    const login = await request(app)
      .post(api('/auth/login'))
      .send({ email: u.user.email, password: u.user.password });
    expect(login.body.requires2fa).toBeFalsy();
    expect(login.body.accessToken).toBeTruthy();
    expect(memoryOutbox.some((m) => m.to === u.user.email && m.text.includes('Se desactivó'))).toBe(true);
  });

  it('el superadmin no puede desactivarla', async () => {
    const admin = await createUser({ isPlatformAdmin: true, totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
    const login = await request(app)
      .post(api('/auth/login'))
      .send({ email: admin.email, password: admin.password });
    const verify = await request(app)
      .post(api('/auth/2fa/verify'))
      .send({
        challengeToken: login.body.challengeToken,
        code: await generate({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }),
      });
    const res = await post(bearer(verify.body.accessToken), '/auth/2fa/disable', {
      password: admin.password,
      code: await generate({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TOTP_REQUIRED_FOR_PLATFORM_ADMIN');
  });
});

describe('restablecimiento por un administrador de la iglesia', () => {
  it('quien puede resetear usuarios la restablece, cierra las sesiones y avisa', async () => {
    const church = await provisionChurch();
    const u = await enrolledUser(church.accountId);
    const admin = await actor({ 'usuarios.resetear': 'all', 'usuarios.ver': 'all' }, church.accountId);

    const res = await post(admin.headers, `/users/${u.user.id}/reset-2fa`);
    expect(res.status).toBe(200);
    expect(res.body.totpEnabled).toBe(false);
    expect((await request(app).get(api('/me')).set(u.headers)).status).toBe(401); // sesiones cortadas
    expect(await prisma.totpRecoveryCode.count({ where: { userId: u.user.id } })).toBe(0);
    const login = await loginAs(u.user);
    expect(login.accessToken).toBeTruthy(); // entra solo con la contraseña
    expect(memoryOutbox.some((m) => m.to === u.user.email && m.text.includes('restableció'))).toBe(true);
    expect(
      await prisma.auditLog.count({ where: { action: 'users.reset_2fa', entityId: String(u.user.id) } }),
    ).toBe(1);

    // Sin 2FA activa no hay nada que resetear; a uno mismo, desde Seguridad.
    expect((await post(admin.headers, `/users/${u.user.id}/reset-2fa`)).body.error.code).toBe(
      'TOTP_NOT_ENABLED',
    );
    expect((await post(admin.headers, `/users/${admin.user.id}/reset-2fa`)).body.error.code).toBe(
      'USE_SECURITY_SETTINGS',
    );
  });

  it('sin permiso no, y a usuarios de otra iglesia tampoco', async () => {
    const church = await provisionChurch();
    const u = await enrolledUser(church.accountId);
    const viewer = await actor({ 'usuarios.ver': 'all' }, church.accountId);
    expect((await post(viewer.headers, `/users/${u.user.id}/reset-2fa`)).status).toBe(403);

    const other = await actor({ 'usuarios.resetear': 'all' });
    await grantRole(other.user, { 'usuarios.ver': 'all' });
    expect((await post(other.headers, `/users/${u.user.id}/reset-2fa`)).status).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.user.id } })).totpEnabled).toBe(true);
  });
});
