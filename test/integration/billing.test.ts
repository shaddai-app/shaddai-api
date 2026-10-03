import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { markPastDue } from '../../src/modules/billing/billing.service.js';
import { FAKE_SIGNATURE, fakeProvider } from '../../src/modules/billing/fake.provider.js';
import { actor, app, platformAdmin, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(async () => {
  await resetDb();
  fakeProvider.reset();
});
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const get = (h: Headers, path: string) => request(app).get(api(path)).set(h);
const send = (h: Headers, method: 'post' | 'patch', path: string, body?: object) =>
  request(app)[method](api(path)).set(h).send(body);
const webhook = (body: object, signature = FAKE_SIGNATURE) =>
  request(app).post(api('/webhooks/billing')).set('x-fake-signature', signature).send(body);
const day = 86_400_000;

/** Iglesia en prueba con precio en pesos en su plan. */
async function setup(priceArs: number | null = 25_000) {
  const church = await provisionChurch();
  const account = await prisma.account.update({
    where: { id: church.accountId },
    data: { status: 'trial', trialEndsAt: new Date(Date.now() + 10 * day) },
  });
  await prisma.plan.update({ where: { id: account.planId }, data: { priceArs } });
  return church;
}

async function subscribed(h: Headers, accountId: number) {
  const res = await send(h, 'post', '/account/billing/subscribe');
  expect(res.status).toBe(201);
  const sub = await prisma.subscription.findFirstOrThrow({ where: { accountId }, orderBy: { id: 'desc' } });
  return { checkoutUrl: res.body.checkoutUrl as string, sub };
}

describe('facturación de la iglesia', () => {
  it('estado inicial, sin precio no se puede suscribir', async () => {
    const church = await setup(null);
    const overview = await get(church.headers, '/account/billing');
    expect(overview.body).toMatchObject({
      provider: 'fake',
      status: 'trial',
      paidUntil: null,
      subscription: null,
      invoices: [],
      plan: { priceArs: null },
    });
    const res = await send(church.headers, 'post', '/account/billing/subscribe');
    expect(res.body.error.code).toBe('BILLING_PLAN_NO_PRICE');
  });

  it('suscribirse y cobrar: activa la cuenta y extiende un mes, una sola vez por cobro', async () => {
    const church = await setup();
    const { checkoutUrl, sub } = await subscribed(church.headers, church.accountId);
    expect(checkoutUrl).toContain('/admin/facturacion?simular=');
    expect(sub).toMatchObject({ status: 'pending', provider: 'fake', currency: 'ARS' });
    expect(Number(sub.amount)).toBe(25_000);

    const ref = fakeProvider.simulatePayment(sub.providerRef);
    expect((await webhook({ kind: 'payment', ref })).status).toBe(200);
    expect((await webhook({ kind: 'payment', ref })).status).toBe(200); // reintento del proveedor

    const overview = (await get(church.headers, '/account/billing')).body;
    expect(overview.status).toBe('active');
    expect(overview.subscription).toMatchObject({ status: 'authorized', checkoutUrl: null });
    expect(overview.invoices).toHaveLength(1);
    expect(overview.invoices[0]).toMatchObject({ status: 'approved', amount: 25_000, provider: 'fake' });
    const paidUntil = new Date(overview.paidUntil).getTime();
    expect(paidUntil).toBeGreaterThan(Date.now() + 27 * day);
    expect(paidUntil).toBeLessThan(Date.now() + 32 * day);

    // El cobro del mes siguiente arranca donde terminó el anterior.
    const next = fakeProvider.simulatePayment(sub.providerRef);
    await webhook({ kind: 'payment', ref: next });
    const after = (await get(church.headers, '/account/billing')).body;
    expect(new Date(after.paidUntil).getTime()).toBeGreaterThan(paidUntil + 27 * day);
    expect(await prisma.auditLog.count({ where: { action: 'billing.payment' } })).toBe(3);
  });

  it('un cobro rechazado se registra pero no cambia nada; una devolución no descuenta', async () => {
    const church = await setup();
    const { sub } = await subscribed(church.headers, church.accountId);
    await webhook({ kind: 'payment', ref: fakeProvider.simulatePayment(sub.providerRef, 'rejected') });
    let overview = (await get(church.headers, '/account/billing')).body;
    expect(overview).toMatchObject({ status: 'trial', paidUntil: null });
    expect(overview.invoices[0].status).toBe('rejected');

    const ref = fakeProvider.simulatePayment(sub.providerRef);
    await webhook({ kind: 'payment', ref });
    fakeProvider.setPaymentStatus(ref, 'refunded');
    await webhook({ kind: 'payment', ref });
    overview = (await get(church.headers, '/account/billing')).body;
    expect(overview.status).toBe('active');
    expect(overview.invoices.map((i: { status: string }) => i.status)).toContain('refunded');
  });

  it('avisos: firma inválida 401, tipo desconocido se ignora, suscripción cancelada se refleja', async () => {
    const church = await setup();
    const { sub } = await subscribed(church.headers, church.accountId);
    expect((await webhook({ kind: 'payment', ref: 'x' }, 'mala')).status).toBe(401);
    expect((await webhook({ kind: 'otro' })).status).toBe(200);
    expect((await webhook({ kind: 'payment', ref: 'no-existe' })).status).toBe(400);

    fakeProvider.setSubscriptionStatus(sub.providerRef, 'cancelled');
    await webhook({ kind: 'subscription', ref: sub.providerRef });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.status).toBe('cancelled');
    expect(row.cancelledAt).not.toBeNull();
  });

  it('volver a suscribirse cancela la pendiente; con una autorizada, 409; cancelar', async () => {
    const church = await setup();
    const first = await subscribed(church.headers, church.accountId);
    const second = await subscribed(church.headers, church.accountId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: first.sub.id } })).status).toBe(
      'cancelled',
    );
    await webhook({ kind: 'payment', ref: fakeProvider.simulatePayment(second.sub.providerRef) });
    const again = await send(church.headers, 'post', '/account/billing/subscribe');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('BILLING_ALREADY_SUBSCRIBED');

    const cancelled = await send(church.headers, 'post', '/account/billing/cancel');
    expect(cancelled.body.subscription.status).toBe('cancelled');
    expect(cancelled.body.status).toBe('active'); // lo pagado se mantiene
    expect((await send(church.headers, 'post', '/account/billing/cancel')).status).toBe(404);
  });

  it('con la prueba vencida (solo lectura) se puede pagar, pero no cargar datos', async () => {
    const church = await setup();
    await prisma.account.update({
      where: { id: church.accountId },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });
    const write = await send(church.headers, 'post', '/people', { firstName: 'Ana', lastName: 'Test' });
    expect(write.body.error.code).toBe('ACCOUNT_READ_ONLY');
    const { sub } = await subscribed(church.headers, church.accountId);
    const paid = await send(church.headers, 'post', '/account/billing/simulate-payment');
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('active');
    expect(sub.status).toBe('pending');
    const ok = await send(church.headers, 'post', '/people', { firstName: 'Ana', lastName: 'Test' });
    expect(ok.status).toBe(201);
  });

  it('solo con cuenta.configurar; cada iglesia ve lo suyo', async () => {
    const church = await setup();
    const member = await actor({ 'personas.ver': 'all' }, church.accountId);
    expect((await get(member.headers, '/account/billing')).status).toBe(403);
    expect((await send(member.headers, 'post', '/account/billing/subscribe')).status).toBe(403);
    await subscribed(church.headers, church.accountId);
    const other = await setup();
    expect((await get(other.headers, '/account/billing')).body.subscription).toBeNull();
  });
});

describe('morosidad y pagos manuales', () => {
  it('vencido el pago más los días de gracia pasa a morosa y avisa a los dueños', async () => {
    const church = await setup();
    const fresh = await setup();
    await prisma.account.update({
      where: { id: church.accountId },
      data: { status: 'active', paidUntil: new Date(Date.now() - 10 * day) },
    });
    await prisma.account.update({
      where: { id: fresh.accountId },
      data: { status: 'active', paidUntil: new Date(Date.now() - 2 * day) },
    });
    expect(await markPastDue()).toEqual([church.accountId]);
    expect(await markPastDue()).toEqual([]);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: church.accountId } })).status).toBe(
      'past_due',
    );
    expect((await prisma.account.findUniqueOrThrow({ where: { id: fresh.accountId } })).status).toBe(
      'active',
    );
    const notice = await prisma.notification.findFirstOrThrow({ where: { type: 'billing.past_due' } });
    expect(notice).toMatchObject({ userId: church.ownerId, link: '/admin/facturacion' });

    // Morosa: solo lectura, pero puede pagar y vuelve a activa.
    const { sub } = await subscribed(church.headers, church.accountId);
    await webhook({ kind: 'payment', ref: fakeProvider.simulatePayment(sub.providerRef) });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: church.accountId } });
    expect(account.status).toBe('active');
    expect(account.paidUntil!.getTime()).toBeGreaterThan(Date.now() + 27 * day);
  });

  it('la plataforma ve la facturación, registra pagos a mano y pone precio a los planes', async () => {
    const church = await setup();
    const admin = await platformAdmin();
    await prisma.account.update({ where: { id: church.accountId }, data: { status: 'past_due' } });
    const paid = await send(admin.headers, 'post', `/platform/accounts/${church.accountId}/payments`, {
      amount: 70_000,
      months: 3,
      note: 'Transferencia',
    });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('active');
    expect(paid.body.invoices[0]).toMatchObject({
      provider: 'manual',
      amount: 70_000,
      note: 'Transferencia',
    });
    const paidUntil = new Date(paid.body.paidUntil).getTime();
    expect(paidUntil).toBeGreaterThan(Date.now() + 88 * day);
    expect(
      (await get(admin.headers, `/platform/accounts/${church.accountId}/billing`)).body.invoices,
    ).toHaveLength(1);
    expect((await get(admin.headers, '/platform/accounts/999999/billing')).status).toBe(404);
    expect(
      (await send(church.headers, 'post', `/platform/accounts/${church.accountId}/payments`, { amount: 1 }))
        .status,
    ).toBe(403);

    const plan = (await prisma.account.findUniqueOrThrow({ where: { id: church.accountId } })).planId;
    const updated = await send(admin.headers, 'patch', `/platform/plans/${plan}`, { priceArs: 30_000 });
    expect(Number(updated.body.priceArs)).toBe(30_000);
  });
});
