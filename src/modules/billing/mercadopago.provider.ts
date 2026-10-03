import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../core/http/errors.js';
import { logger } from '../../core/logger.js';
import type {
  BillingProvider,
  PaymentStatus,
  ProviderPayment,
  ProviderSubscription,
  SubscriptionStatus,
  WebhookRequest,
} from './provider.js';

// Mercado Pago, suscripciones (preapproval) por la API REST, sin SDK:
// - POST /preapproval crea el débito automático "pending" y devuelve init_point (checkout).
// - Los avisos llegan al webhook configurado en el panel de MP (tipos subscription_preapproval,
//   subscription_authorized_payment y payment) firmados con x-signature; el detalle se consulta
//   siempre a la API, nunca se confía en el cuerpo del aviso.
// Pendiente de validar en sandbox con las credenciales reales (ver docs/produccion.md).

const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 15_000;

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // El cuerpo del error de MP no tiene datos sensibles (no repite el token); se loguea para soporte.
    const detail = await res.text().catch(() => '');
    logger.warn({ status: res.status, path, detail: detail.slice(0, 500) }, 'mercadopago request failed');
    throw AppError.badGateway('BILLING_PROVIDER_ERROR');
  }
  return (await res.json()) as T;
}

interface MpPreapproval {
  id: string;
  status: string;
  external_reference?: string | null;
  init_point?: string | null;
  next_payment_date?: string | null;
}

interface MpAuthorizedPayment {
  id: number | string;
  preapproval_id?: string | null;
  external_reference?: string | null;
  transaction_amount?: number;
  currency_id?: string;
  debit_date?: string | null;
  status?: string; // scheduled|processed|recycling|cancelled
  payment?: { id?: number | string; status?: string; status_detail?: string } | null;
}

interface MpPayment {
  id: number | string;
  status: string;
  transaction_amount?: number;
  currency_id?: string;
  date_approved?: string | null;
  external_reference?: string | null;
  metadata?: { preapproval_id?: string } | null;
  point_of_interaction?: { transaction_data?: { subscription_id?: string } } | null;
}

const SUBSCRIPTION_STATUS: Record<string, SubscriptionStatus> = {
  pending: 'pending',
  authorized: 'authorized',
  paused: 'paused',
  cancelled: 'cancelled',
};

function paymentStatus(status: string | undefined): PaymentStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'refunded':
    case 'charged_back':
      return 'refunded';
    case 'rejected':
    case 'cancelled':
      return 'rejected';
    default:
      return 'pending'; // in_process, pending, authorized…
  }
}

const date = (v: string | null | undefined) => (v ? new Date(v) : null);

function toSubscription(p: MpPreapproval): ProviderSubscription {
  return {
    ref: p.id,
    status: SUBSCRIPTION_STATUS[p.status] ?? 'pending',
    externalRef: p.external_reference ?? null,
    checkoutUrl: p.init_point ?? null,
    nextPaymentAt: date(p.next_payment_date),
  };
}

const header = (req: WebhookRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Firma de MP: x-signature = "ts=<epoch>,v1=<hmac>", con HMAC-SHA256 (secreto del webhook) de
 * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (data.id en minúsculas si es alfanumérico).
 */
export function verifyMercadoPagoSignature(req: WebhookRequest, secret: string, dataId: string): boolean {
  const signature = header(req, 'x-signature');
  const requestId = header(req, 'x-request-id');
  if (!signature || !requestId) return false;
  const parts = Object.fromEntries(
    signature.split(',').map((p) => {
      const [k, ...v] = p.trim().split('=');
      return [k, v.join('=')];
    }),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${requestId};ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const mercadoPagoProvider: BillingProvider = {
  name: 'mercadopago',

  async createSubscription(input) {
    const created = await call<MpPreapproval>('POST', '/preapproval', {
      reason: input.reason,
      external_reference: input.externalRef,
      payer_email: input.payerEmail,
      back_url: input.backUrl,
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: input.amount,
        currency_id: input.currency,
      },
    });
    return toSubscription(created);
  },

  async getSubscription(ref) {
    return toSubscription(await call<MpPreapproval>('GET', `/preapproval/${encodeURIComponent(ref)}`));
  },

  async cancelSubscription(ref) {
    await call('PUT', `/preapproval/${encodeURIComponent(ref)}`, { status: 'cancelled' });
  },

  async getPayment(ref) {
    // Cobro de una suscripción ("ap-<id>") o pago común ("<id>").
    if (ref.startsWith('ap-')) {
      const ap = await call<MpAuthorizedPayment>(
        'GET',
        `/authorized_payments/${encodeURIComponent(ref.slice(3))}`,
      );
      const result: ProviderPayment = {
        ref,
        status: paymentStatus(ap.payment?.status),
        amount: ap.transaction_amount ?? 0,
        currency: ap.currency_id ?? 'ARS',
        paidAt: ap.payment?.status === 'approved' ? (date(ap.debit_date) ?? new Date()) : null,
        subscriptionRef: ap.preapproval_id ?? null,
        externalRef: ap.external_reference ?? null,
      };
      return result;
    }
    const p = await call<MpPayment>('GET', `/v1/payments/${encodeURIComponent(ref)}`);
    return {
      ref,
      status: paymentStatus(p.status),
      amount: p.transaction_amount ?? 0,
      currency: p.currency_id ?? 'ARS',
      paidAt: date(p.date_approved),
      subscriptionRef:
        p.metadata?.preapproval_id ?? p.point_of_interaction?.transaction_data?.subscription_id ?? null,
      externalRef: p.external_reference ?? null,
    };
  },

  parseWebhook(req) {
    const body = (req.body ?? {}) as { type?: string; data?: { id?: string | number } };
    const queryId = req.query['data.id'];
    const dataId = String(typeof queryId === 'string' ? queryId : (body.data?.id ?? ''));
    const type = body.type ?? (typeof req.query.type === 'string' ? req.query.type : '');
    if (!dataId || !/^[\w-]{1,64}$/.test(dataId)) return null;
    if (!verifyMercadoPagoSignature(req, env.MP_WEBHOOK_SECRET ?? '', dataId)) return null;
    switch (type) {
      case 'subscription_preapproval':
        return { kind: 'subscription', ref: dataId };
      case 'subscription_authorized_payment':
        return { kind: 'payment', ref: `ap-${dataId}` };
      case 'payment':
        return { kind: 'payment', ref: dataId };
      default:
        return { ignore: true };
    }
  },
};
