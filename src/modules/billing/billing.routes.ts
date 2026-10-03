import { Router } from 'express';
import { z } from 'zod';
import { billingProviderName } from '../../config/env.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';
import { platformRouter, tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { authOf } from '../../core/middleware/authenticate.js';
import { publicReadLimiter } from '../../core/middleware/rate-limit.js';
import { logger } from '../../core/logger.js';
import * as billing from './billing.service.js';
import { fakeProvider } from './fake.provider.js';

// Facturación de la iglesia: funciona también con la cuenta en solo lectura (morosa o con la prueba
// vencida), justamente para poder pagar.
const t = tenantRouter({ allowReadOnly: true });
export const billingRouter = t.router;

const accountId = (req: Parameters<typeof authOf>[0]) => authOf(req).accountId!;

t.get('/account/billing', 'cuenta.configurar', async (req, res) => {
  res.json(await billing.billingOverview(accountId(req)));
});

t.post('/account/billing/subscribe', 'cuenta.configurar', async (req, res) => {
  res.status(201).json(await billing.subscribe(authOf(req).userId, accountId(req)));
});

t.post('/account/billing/cancel', 'cuenta.configurar', async (req, res) => {
  await billing.cancelSubscription(authOf(req).userId, accountId(req));
  res.json(await billing.billingOverview(accountId(req)));
});

/** Solo con el proveedor de prueba: simula el cobro del débito (como si llegara el aviso). */
t.post('/account/billing/simulate-payment', 'cuenta.configurar', async (req, res) => {
  if (billingProviderName !== 'fake') throw AppError.notFound('NOT_FOUND');
  const { status } = parse(
    z.object({ status: z.enum(['approved', 'rejected']).default('approved') }).strict(),
    req.body ?? {},
  );
  const sub = await prisma.subscription.findFirst({
    where: { accountId: accountId(req), provider: 'fake', status: { in: ['pending', 'authorized'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (!sub) throw AppError.notFound('BILLING_NO_SUBSCRIPTION');
  const ref = fakeProvider.simulatePayment(sub.providerRef, status);
  await billing.handleWebhook({ kind: 'payment', ref });
  res.json(await billing.billingOverview(accountId(req)));
});

// ───────────── Webhook del proveedor (sin sesión: lo autentica la firma) ─────────────

export const billingWebhookRouter = Router();

billingWebhookRouter.post('/webhooks/billing', publicReadLimiter, async (req, res) => {
  const provider = billing.billingProvider();
  if (!provider) throw AppError.notFound('NOT_FOUND');
  const event = provider.parseWebhook({ headers: req.headers, query: req.query, body: req.body });
  if (!event) throw AppError.unauthorized('BILLING_WEBHOOK_SIGNATURE');
  if ('ignore' in event) {
    res.status(200).json({ ok: true });
    return;
  }
  const result = await billing.handleWebhook(event);
  if (result === 'unknown') logger.info({ event }, 'billing webhook for an unknown resource');
  // 200 aunque no sea nuestro: si no, el proveedor reintenta para siempre.
  res.status(200).json({ ok: true });
});

// ───────────── Plataforma ─────────────

const p = platformRouter();
export const platformBillingRouter = p.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

p.get('/platform/accounts/:id/billing', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  if (!(await prisma.account.count({ where: { id } }))) throw AppError.notFound('ACCOUNT_NOT_FOUND');
  res.json(await billing.billingOverview(id, 100));
});

p.post('/platform/accounts/:id/payments', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(billing.ManualPaymentSchema, req.body);
  res.status(201).json(await billing.recordManualPayment(authOf(req).userId, id, input));
});
