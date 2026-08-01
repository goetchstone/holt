// /app/src/lib/payments/types.ts
//
// The provider-neutral payment seam.
//
// Before this existed, "take a card payment" meant "call the Stripe SDK", and
// that call was duplicated across four checkout sites plus the webhook and the
// refund path. Adding a second processor would have meant touching all of them.
//
// The shape below is derived from what the Stripe integration ACTUALLY does in
// this codebase — not from a generic payments abstraction. Every method here
// has a real call site today. Nothing speculative (saved cards, subscriptions,
// multi-currency, split tender) is modelled, because nothing in Holt does it.
//
// Capabilities, not assumptions
// -----------------------------
// Processors differ in kind, not just in API. Square drives its readers from
// the server (POST a terminal checkout, poll for the result); Stripe Terminal
// drives them from the client (browser SDK holds the connection). A provider
// therefore DECLARES what it supports and only implements those methods, and
// callers check `capabilities` before dispatching. That is what lets a third
// processor arrive later supporting terminals but not hosted checkout, or the
// reverse, without reshaping this file.

/**
 * Registered processors. Adding one means: a new id here, a module implementing
 * `PaymentProvider`, an entry in `INTEGRATION_PROVIDERS` (credential fields),
 * and a case in the registry. Nothing else in the app should learn its name.
 */
export type PaymentProviderId = "stripe" | "square";

export interface ProviderCapabilities {
  /** Redirect/link checkout hosted by the processor (invoice + order pay links). */
  hostedCheckout: boolean;
  /** Card-present payments on a physical reader at a register. */
  terminal: boolean;
  /** Refunding a previously captured payment through the processor. */
  refunds: boolean;
}

/** Amounts crossing this seam are in MAJOR units (dollars), matching Payment.paymentAmount.
 *  Each provider converts to its own wire format (both Stripe and Square use minor
 *  units) so no caller has to remember which processor wants cents. */
export interface CheckoutRequest {
  amount: number;
  currency: string;
  /** Line-item label the customer sees, e.g. "Invoice INV-1042 — Saybrook Home". */
  description: string;
  customerEmail?: string;
  /** Echoed back on the webhook. Holt routes structurally off Payment rows, so
   *  this is a cross-check, never the source of truth. */
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  /** Where to send the payer. */
  url: string;
  /** Stored on Payment.processorTxnId; the webhook and refunds key off it. */
  providerTxnId: string;
}

/**
 * Everything a provider might need to authenticate a webhook. Deliberately the
 * whole header map plus the request URL rather than a single signature string:
 * Stripe signs the body against one header, Square HMACs the notification URL
 * concatenated with the body. A narrower shape would have leaked Stripe's
 * mechanism into the interface.
 */
export interface WebhookVerifyRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  /** Absolute URL the processor delivered to — required by Square, ignored by Stripe. */
  requestUrl?: string;
}

/** Opaque, provider-specific parsed event. Only the owning provider interprets it. */
export interface VerifiedWebhookEvent {
  providerId: PaymentProviderId;
  type: string;
  raw: unknown;
}

/**
 * The provider-neutral "this payment succeeded" fact, extracted from whatever
 * event shape the processor sent. Null from `extractCompletion` means the event
 * was authentic but not a completion (a processor sends many event types).
 */
export interface PaymentCompletion {
  /** Matches Payment.processorTxnId written at checkout-creation time. */
  providerTxnId: string;
  metadata: Record<string, string>;
  cardLast4?: string;
  cardBrand?: string;
  /** Provider-shaped extras persisted to Payment.processorData. */
  processorData?: Record<string, unknown>;
}

/**
 * Post-redirect status poll. The payer lands back on the success page before
 * the webhook has necessarily arrived, so the UI asks the processor directly
 * whether the money actually moved. Distinct from the webhook path: this is a
 * read, carries no authority, and never posts to the ledger.
 *
 * Deliberately carries NO customer detail. The only caller is a public,
 * rate-limited polling endpoint, and processor session ids travel client-side —
 * so returning an email or order reference here would let any visitor read
 * another customer's data by guessing an id. Keeping PII off this type means a
 * future provider implementation cannot reintroduce that leak by accident.
 */
export interface SessionStatus {
  /** Processor-neutral outcome. "open" means still awaiting payer action. */
  status: "open" | "complete" | "expired";
  paid: boolean;
}

export interface RefundRequest {
  /** Whatever the ORIGINAL payment stored — a Stripe checkout session id, a
   *  Square payment id. Each provider hides its own indirection (Stripe must
   *  resolve session → payment intent first; Square refunds the id directly). */
  providerTxnId: string;
  amount: number;
  reason?: string;
}

export interface RefundResult {
  /** The processor's refund id, stored on the refund Payment row. Null when the
   *  provider completed no remote call (e.g. nothing to refund upstream). */
  refundId: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Card-present. Modelled now, deliberately, even though no provider ships it
// yet: retrofitting terminals onto a checkout-only interface is exactly the
// reshape this seam exists to avoid.
// ---------------------------------------------------------------------------

export interface TerminalCheckoutRequest {
  amount: number;
  currency: string;
  /** Processor-side reader identifier, from Register configuration. */
  deviceId: string;
  referenceId?: string;
  metadata?: Record<string, string>;
}

export type TerminalCheckoutStatus = "PENDING" | "COMPLETED" | "CANCELED" | "FAILED";

export interface TerminalCheckoutResult {
  providerTxnId: string;
  status: TerminalCheckoutStatus;
  cardLast4?: string;
  cardBrand?: string;
  processorData?: Record<string, unknown>;
}

/**
 * One processor's implementation. Optional members are gated by `capabilities`
 * — call `assertCapability` (see ./index) rather than testing for the function,
 * so a misconfiguration fails with an operator-readable message instead of
 * "x is not a function".
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  createCheckout?(req: CheckoutRequest): Promise<CheckoutResult>;
  /** Poll a hosted checkout's outcome by the id stored in Payment.processorTxnId. */
  retrieveSession?(providerTxnId: string): Promise<SessionStatus>;
  verifyWebhook?(req: WebhookVerifyRequest): Promise<VerifiedWebhookEvent>;
  extractCompletion?(event: VerifiedWebhookEvent): Promise<PaymentCompletion | null>;
  refund?(req: RefundRequest): Promise<RefundResult>;

  createTerminalCheckout?(req: TerminalCheckoutRequest): Promise<TerminalCheckoutResult>;
  getTerminalCheckout?(providerTxnId: string): Promise<TerminalCheckoutResult>;
  cancelTerminalCheckout?(providerTxnId: string): Promise<void>;

  testConnection(): Promise<ConnectionTestResult>;
}
