import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { billingProviderName, env } from '../../config/env.js';
import { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { runInContext } from '../../core/context.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';
import { logger } from '../../core/logger.js';
import { notify } from '../notifications/notifications.service.js';
import { fakeProvider } from './fake.provider.js';
import { mercadoPagoProvider } from './mercadopago.provider.js';
import type { BillingProvider, ProviderPayment, WebhookEvent } from './provider.js';

// Cobro del servicio a las iglesias. La iglesia se suscribe (débito automático mensual en el
// proveedor); cada cobro aprobado extiende Account.paidUntil un mes y, si la cuenta estaba en prueba
// o morosa, la activa. Un proceso diario pasa a "morosa" (solo lectura) a la cuenta activa cuyo pago
// venció hace más de BILLING_GRACE_DAYS. La plataforma también puede registrar pagos a mano.
// Las tablas se leen sin filtro de tenant: esto lo usan también el webhook y la plataforma.

export const CURRENCY = 'ARS';

/** El proveedor configurado, o null si el cobro automático está apagado. */
export function billingProvider(): BillingProvider | null {
  if (billingProviderName === 'mercadopago') return mercadoPagoProvider;
  if (billingProviderName === 'fake') return fakeProvider;
  return null;
}

function requireProvider() {
  const provider = billingProvider();
  if (!provider) throw AppError.badRequest('BILLING_DISABLED');
  return provider;
}

/** Suma un mes calendario (el 31/1 pasa al 28 o 29/2). */
export function addMonths(date: Date, months: number): Date {
  const r = new Date(date);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, lastDay));
  return r;
}

const OPEN_SUBSCRIPTION = { in: ['pending', 'authorized', 'paused'] };

const subscriptionSelect = {
  id: true,
  provider: true,
  status: true,
  amount: true,
  currency: true,
  checkoutUrl: true,
  nextPaymentAt: true,
  createdAt: true,
  cancelledAt: true,
} as const;

const invoiceSelect = {
  id: true,
  provider: true,
  status: true,
  amount: true,
  currency: true,
  periodStart: true,
  periodEnd: true,
  paidAt: true,
  note: true,
  createdAt: true,
} as const;

const money = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/** Estado del cobro de una iglesia: plan, pagado hasta, suscripción vigente y últimos pagos. */
export async function billingOverview(accountId: number, invoiceLimit = 24) {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      status: true,
      trialEndsAt: true,
      paidUntil: true,
      plan: { select: { code: true, name: true, priceArs: true } },
    },
  });
  const [subscription, invoices] = await Promise.all([
    prisma.subscription.findFirst({
      where: { accountId },
      select: subscriptionSelect,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.invoice.findMany({
      where: { accountId },
      select: invoiceSelect,
      orderBy: { createdAt: 'desc' },
      take: invoiceLimit,
    }),
  ]);
  return {
    provider: billingProviderName,
    graceDays: env.BILLING_GRACE_DAYS,
    status: account.status,
    trialEndsAt: account.trialEndsAt,
    paidUntil: account.paidUntil,
    plan: { ...account.plan, priceArs: money(account.plan.priceArs) },
    subscription: subscription
      ? {
          ...subscription,
          amount: Number(subscription.amount),
          // El enlace al checkout solo sirve mientras está pendiente.
          checkoutUrl: subscription.status === 'pending' ? subscription.checkoutUrl : null,
        }
      : null,
    invoices: invoices.map((i) => ({ ...i, amount: Number(i.amount) })),
  };
}

/**
 * Crea el débito automático en el proveedor y devuelve el enlace al checkout. Si había uno pendiente
 * (no completado), se cancela; con uno autorizado, 409.
 */
export async function subscribe(userId: number, accountId: number) {
  const provider = requireProvider();
  const [account, user] = await Promise.all([
    prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { name: true, planId: true, plan: { select: { name: true, priceArs: true } } },
    }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
  ]);
  if (!account.plan.priceArs || Number(account.plan.priceArs) <= 0) {
    throw AppError.badRequest('BILLING_PLAN_NO_PRICE');
  }
  const open = await prisma.subscription.findMany({ where: { accountId, status: OPEN_SUBSCRIPTION } });
  if (open.some((s) => s.status !== 'pending')) throw AppError.conflict('BILLING_ALREADY_SUBSCRIBED');
  for (const s of open) await cancelAtProvider(provider, s.id, s.providerRef);

  const externalRef = `acct-${accountId}-${randomUUID()}`;
  const amount = Number(account.plan.priceArs);
  const created = await provider.createSubscription({
    reason: `Shaddai — ${account.plan.name} (${account.name})`.slice(0, 250),
    amount,
    currency: CURRENCY,
    payerEmail: user.email,
    externalRef,
    backUrl: `${env.APP_URL}/admin/facturacion`,
  });
  const row = await prisma.subscription.create({
    data: {
      accountId,
      planId: account.planId,
      provider: provider.name,
      providerRef: created.ref,
      externalRef,
      status: created.status,
      amount,
      currency: CURRENCY,
      payerEmail: user.email,
      checkoutUrl: created.checkoutUrl,
      nextPaymentAt: created.nextPaymentAt,
      createdById: userId,
    },
  });
  await audit({
    action: 'billing.subscribe',
    entity: 'Subscription',
    entityId: row.id,
    accountId,
    after: { provider: provider.name, amount, currency: CURRENCY },
  });
  return { checkoutUrl: created.checkoutUrl };
}

async function cancelAtProvider(provider: BillingProvider, id: number, ref: string) {
  try {
    await provider.cancelSubscription(ref);
  } catch (err) {
    // Uno pendiente que el proveedor ya no conoce no frena la nueva suscripción.
    logger.warn({ err, subscriptionId: id }, 'billing: could not cancel pending subscription');
  }
  await prisma.subscription.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date(), checkoutUrl: null },
  });
}

/** Cancela el débito automático. Lo ya pagado se mantiene hasta paidUntil. */
export async function cancelSubscription(userId: number, accountId: number) {
  const provider = requireProvider();
  const open = await prisma.subscription.findFirst({
    where: { accountId, status: OPEN_SUBSCRIPTION },
    orderBy: { createdAt: 'desc' },
  });
  if (!open) throw AppError.notFound('BILLING_NO_SUBSCRIPTION');
  await provider.cancelSubscription(open.providerRef);
  await prisma.subscription.update({
    where: { id: open.id },
    data: { status: 'cancelled', cancelledAt: new Date(), checkoutUrl: null },
  });
  await audit({ action: 'billing.cancel', entity: 'Subscription', entityId: open.id, accountId, userId });
}

// ───────────── Avisos del proveedor ─────────────

async function findSubscription(provider: BillingProvider, ref: string | null, externalRef: string | null) {
  if (ref) {
    const byRef = await prisma.subscription.findUnique({
      where: { provider_providerRef: { provider: provider.name, providerRef: ref } },
    });
    if (byRef) return byRef;
  }
  return externalRef ? prisma.subscription.findUnique({ where: { externalRef } }) : null;
}

/**
 * Procesa un aviso ya verificado: consulta el recurso al proveedor y actualiza la suscripción o
 * registra el cobro. Idempotente (el proveedor reintenta los avisos).
 */
export async function handleWebhook(event: WebhookEvent): Promise<'ok' | 'unknown'> {
  const provider = requireProvider();
  if (event.kind === 'subscription') {
    const remote = await provider.getSubscription(event.ref);
    const sub = await findSubscription(provider, remote.ref, remote.externalRef);
    if (!sub) return 'unknown';
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: remote.status,
        nextPaymentAt: remote.nextPaymentAt,
        ...(remote.status === 'cancelled' && !sub.cancelledAt ? { cancelledAt: new Date() } : {}),
        ...(remote.status !== 'pending' ? { checkoutUrl: null } : {}),
      },
    });
    return 'ok';
  }
  const payment = await provider.getPayment(event.ref);
  const sub = await findSubscription(provider, payment.subscriptionRef, payment.externalRef);
  if (!sub) {
    logger.warn({ ref: event.ref }, 'billing: payment for an unknown subscription');
    return 'unknown';
  }
  await applyPayment(provider.name, sub, payment);
  return 'ok';
}

const isDuplicate = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Registra (o actualiza) el cobro; si queda aprobado por primera vez, extiende paidUntil. */
async function applyPayment(
  provider: 'mercadopago' | 'fake',
  sub: { id: number; accountId: number },
  payment: ProviderPayment,
) {
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.invoice.findUnique({
        where: { provider_providerRef: { provider, providerRef: payment.ref } },
      });
      if (existing?.status === 'approved') {
        // Ya contó: solo se registra una devolución (el período no se descuenta solo).
        if (payment.status === 'refunded') {
          await tx.invoice.update({ where: { id: existing.id }, data: { status: 'refunded' } });
        }
        return;
      }
      let period: { periodStart: Date; periodEnd: Date } | null = null;
      if (payment.status === 'approved') {
        const paidAt = payment.paidAt ?? new Date();
        const account = await tx.account.findUniqueOrThrow({
          where: { id: sub.accountId },
          select: { status: true, paidUntil: true },
        });
        const start = account.paidUntil && account.paidUntil > paidAt ? account.paidUntil : paidAt;
        period = { periodStart: start, periodEnd: addMonths(start, 1) };
        await tx.account.update({
          where: { id: sub.accountId },
          data: {
            paidUntil: period.periodEnd,
            ...(['trial', 'past_due'].includes(account.status) ? { status: 'active' } : {}),
          },
        });
        await tx.subscription.update({
          where: { id: sub.id },
          data: { status: 'authorized', checkoutUrl: null },
        });
      }
      const data = {
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        paidAt: payment.status === 'approved' ? (payment.paidAt ?? new Date()) : null,
        ...(period ?? {}),
      };
      if (existing) {
        await tx.invoice.update({ where: { id: existing.id }, data });
      } else {
        await tx.invoice.create({
          data: {
            ...data,
            accountId: sub.accountId,
            subscriptionId: sub.id,
            provider,
            providerRef: payment.ref,
          },
        });
      }
    });
  } catch (err) {
    // Dos avisos simultáneos del mismo cobro: el otro ya lo registró.
    if (isDuplicate(err)) return;
    throw err;
  }
  await audit({
    action: 'billing.payment',
    entity: 'Subscription',
    entityId: sub.id,
    accountId: sub.accountId,
    userId: null,
    after: { ref: payment.ref, status: payment.status, amount: payment.amount },
  });
}

// ───────────── Plataforma ─────────────

export const ManualPaymentSchema = z
  .object({
    amount: z.number().min(0).max(100_000_000),
    currency: z.string().length(3).toUpperCase().default(CURRENCY),
    months: z.number().int().min(1).max(24).default(1),
    paidAt: z.coerce.date().optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

/** Pago registrado a mano (transferencia, efectivo): extiende paidUntil los meses indicados. */
export async function recordManualPayment(
  adminUserId: number,
  accountId: number,
  input: z.infer<typeof ManualPaymentSchema>,
) {
  const paidAt = input.paidAt ?? new Date();
  const invoice = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true, paidUntil: true },
    });
    if (!account) throw AppError.notFound('ACCOUNT_NOT_FOUND');
    const start = account.paidUntil && account.paidUntil > paidAt ? account.paidUntil : paidAt;
    const periodEnd = addMonths(start, input.months);
    await tx.account.update({
      where: { id: accountId },
      data: {
        paidUntil: periodEnd,
        ...(['trial', 'past_due'].includes(account.status) ? { status: 'active' } : {}),
      },
    });
    return tx.invoice.create({
      data: {
        accountId,
        provider: 'manual',
        providerRef: `manual-${randomUUID()}`,
        status: 'approved',
        amount: input.amount,
        currency: input.currency,
        periodStart: start,
        periodEnd,
        paidAt,
        note: input.note ?? null,
        createdById: adminUserId,
      },
    });
  });
  await audit({
    action: 'platform.billing.manual_payment',
    entity: 'Invoice',
    entityId: invoice.id,
    accountId,
    after: { amount: input.amount, currency: input.currency, months: input.months, note: input.note },
  });
  return billingOverview(accountId, 100);
}

// ───────────── Proceso diario ─────────────

/**
 * Cuentas activas cuyo pago venció hace más de BILLING_GRACE_DAYS: pasan a morosas (solo lectura) y
 * se avisa a sus dueños. Las activas sin paidUntil (activadas a mano, sin cobro) no se tocan.
 */
export async function markPastDue(now = new Date()): Promise<number[]> {
  const limit = new Date(now.getTime() - env.BILLING_GRACE_DAYS * 86_400_000);
  const due = await prisma.account.findMany({
    where: { status: 'active', paidUntil: { lt: limit } },
    select: { id: true, paidUntil: true },
  });
  const changed: number[] = [];
  for (const account of due) {
    const { count } = await prisma.account.updateMany({
      where: { id: account.id, status: 'active', paidUntil: { lt: limit } },
      data: { status: 'past_due' },
    });
    if (!count) continue;
    changed.push(account.id);
    await audit({
      action: 'billing.past_due',
      entity: 'Account',
      entityId: account.id,
      accountId: account.id,
      userId: null,
      after: { paidUntil: account.paidUntil },
    });
    await runInContext({ requestId: `job-${randomUUID()}`, accountId: account.id }, async () => {
      const owners = await prisma.user.findMany({
        where: { accountId: account.id, isAccountOwner: true, isActive: true, deletedAt: null },
        select: { id: true },
      });
      await notify({
        userIds: owners.map((o) => o.id),
        type: 'billing.past_due',
        params: { paidUntil: account.paidUntil!.toISOString().slice(0, 10) },
        link: '/admin/facturacion',
        dedupeKey: `billing-past-due:${account.paidUntil!.toISOString()}`,
      });
    });
  }
  return changed;
}
