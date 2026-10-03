import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../core/http/errors.js';
import type {
  BillingProvider,
  CreateSubscriptionInput,
  PaymentStatus,
  ProviderPayment,
  ProviderSubscription,
  SubscriptionStatus,
} from './provider.js';

// Proveedor de prueba: guarda todo en memoria, sin red ni dinero. En desarrollo el "checkout" es la
// misma página de facturación con un botón "Simular pago"; en los tests se usan simulatePayment y
// setSubscriptionStatus. Sus avisos llevan la cabecera x-fake-signature (no es seguridad: este
// proveedor no se puede usar en producción, lo impide la validación del entorno).

type FakeSubscription = ProviderSubscription & { amount: number; currency: string };
const subscriptions = new Map<string, FakeSubscription>();
const payments = new Map<string, ProviderPayment>();

export const FAKE_SIGNATURE = 'fake-ok';

const toProvider = ({ amount: _a, currency: _c, ...sub }: FakeSubscription): ProviderSubscription => ({
  ...sub,
});

export const fakeProvider: BillingProvider & {
  simulatePayment(subscriptionRef: string, status?: PaymentStatus, amount?: number): string;
  setSubscriptionStatus(ref: string, status: SubscriptionStatus): void;
  setPaymentStatus(ref: string, status: PaymentStatus): void;
  reset(): void;
} = {
  name: 'fake',

  async createSubscription(input: CreateSubscriptionInput) {
    const ref = `fake-sub-${randomUUID()}`;
    const sub: FakeSubscription = {
      ref,
      status: 'pending',
      externalRef: input.externalRef,
      checkoutUrl: `${env.APP_URL}/admin/facturacion?simular=${encodeURIComponent(ref)}`,
      nextPaymentAt: null,
      amount: input.amount,
      currency: input.currency,
    };
    subscriptions.set(ref, sub);
    return toProvider(sub);
  },

  async getSubscription(ref) {
    const sub = subscriptions.get(ref);
    if (!sub) throw AppError.badRequest('BILLING_PROVIDER_NOT_FOUND');
    return toProvider(sub);
  },

  async cancelSubscription(ref) {
    const sub = subscriptions.get(ref);
    if (sub) sub.status = 'cancelled';
  },

  async getPayment(ref) {
    const payment = payments.get(ref);
    if (!payment) throw AppError.badRequest('BILLING_PROVIDER_NOT_FOUND');
    return { ...payment };
  },

  parseWebhook(req) {
    if (req.headers['x-fake-signature'] !== FAKE_SIGNATURE) return null;
    const body = req.body as { kind?: unknown; ref?: unknown } | undefined;
    if ((body?.kind === 'subscription' || body?.kind === 'payment') && typeof body.ref === 'string') {
      return { kind: body.kind, ref: body.ref };
    }
    return { ignore: true };
  },

  /** Un cobro del débito automático: autoriza la suscripción y devuelve la referencia del pago. */
  simulatePayment(subscriptionRef, status = 'approved', amount) {
    const sub = subscriptions.get(subscriptionRef);
    if (!sub) throw AppError.badRequest('BILLING_PROVIDER_NOT_FOUND');
    if (status === 'approved') sub.status = 'authorized';
    const ref = `fake-pay-${randomUUID()}`;
    payments.set(ref, {
      ref,
      status,
      amount: amount ?? sub.amount,
      currency: sub.currency,
      paidAt: status === 'approved' ? new Date() : null,
      subscriptionRef,
      externalRef: sub.externalRef,
    });
    sub.nextPaymentAt = new Date(Date.now() + 30 * 86_400_000);
    return ref;
  },

  setSubscriptionStatus(ref, status) {
    const sub = subscriptions.get(ref);
    if (sub) sub.status = status;
  },

  setPaymentStatus(ref, status) {
    const payment = payments.get(ref);
    if (payment) payment.status = status;
  },

  reset() {
    subscriptions.clear();
    payments.clear();
  },
};
