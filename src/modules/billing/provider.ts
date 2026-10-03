// Interfaz con el proveedor de cobros. El servicio de facturación solo habla con esta interfaz:
// Mercado Pago en producción, "fake" en desarrollo y tests (sin dinero ni red).

export type SubscriptionStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'refunded';

export interface CreateSubscriptionInput {
  /** Texto que ve quien paga ("Shaddai — Plan Estándar"). */
  reason: string;
  amount: number;
  currency: string;
  payerEmail: string;
  /** Referencia propia que el proveedor devuelve en sus avisos. */
  externalRef: string;
  /** A dónde vuelve quien paga después del checkout. */
  backUrl: string;
}

export interface ProviderSubscription {
  ref: string;
  status: SubscriptionStatus;
  externalRef: string | null;
  /** Para redirigir a quien paga (checkout del proveedor). */
  checkoutUrl: string | null;
  nextPaymentAt: Date | null;
}

export interface ProviderPayment {
  ref: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  paidAt: Date | null;
  /** Suscripción a la que pertenece el cobro (si el proveedor la informa). */
  subscriptionRef: string | null;
  externalRef: string | null;
}

/** Lo que dice un aviso (webhook) ya verificado: qué recurso cambió. El detalle se consulta aparte. */
export type WebhookEvent = { kind: 'subscription' | 'payment'; ref: string };

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
}

export interface BillingProvider {
  readonly name: 'mercadopago' | 'fake';
  createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>;
  getSubscription(ref: string): Promise<ProviderSubscription>;
  cancelSubscription(ref: string): Promise<void>;
  getPayment(ref: string): Promise<ProviderPayment>;
  /**
   * Verifica la firma del aviso y devuelve el recurso afectado; null si la firma no es válida.
   * Un aviso de un tipo que no interesa devuelve { ignore: true }.
   */
  parseWebhook(req: WebhookRequest): WebhookEvent | { ignore: true } | null;
}
