// /app/src/lib/payments/stripeProvider.ts
//
// Stripe behind the provider seam. This is a REWIRING, not a rewrite: every
// behaviour here is lifted from the call sites it replaces
// (lib/billing/invoiceStripe.ts, pages/api/stripe/{webhook,create-checkout,
// send-payment-link}.ts, lib/paymentService.ts::processRefund), including the
// pinned API version and the two-hop retrieve used to recover card brand/last4.
//
// Card readers use Stripe Terminal's server-driven integration: the server
// creates a card_present PaymentIntent and hands it to the reader
// (readers.processPaymentIntent), then learns the outcome by asking for the
// PaymentIntent, with the `payment_intent.succeeded` webhook as the backstop
// for a register that closed mid-payment. Nothing runs in the browser. It
// works with Stripe's smart readers (S700, WisePOS E and the like), not its
// Bluetooth mobile readers. NOT YET RUN AGAINST STRIPE OR A READER: see
// docs/domains/pos.md, "Card readers".

import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import type {
  CheckoutRequest,
  CheckoutResult,
  ConnectionTestResult,
  PaymentCompletion,
  PaymentExpiration,
  PaymentProvider,
  ProcessorReader,
  ReaderLocation,
  ReaderLocationInput,
  RefundRequest,
  RegisterReaderRequest,
  RefundResult,
  SessionStatus,
  TerminalCheckoutRequest,
  TerminalCheckoutResult,
  VerifiedWebhookEvent,
  WebhookVerifyRequest,
} from "@/lib/payments/types";
import { REFUND_REQUEST_TIMEOUT_MS } from "@/lib/payments/types";

/** Both of a refund's requests: bounded, so the refund lock outlasts them. */
const REFUND_REQUEST: Stripe.RequestOptions = {
  timeout: REFUND_REQUEST_TIMEOUT_MS,
  maxNetworkRetries: 1,
};

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Marks a PaymentIntent as one Holt sent to a reader. A hosted checkout's
 * PaymentIntent fires `payment_intent.succeeded` too and must not be read as a
 * reader payment: Stripe does not copy a Checkout Session's metadata onto its
 * PaymentIntent, so only the ones created below carry this.
 */
export const READER_PAYMENT_FLAG = "holt_reader_payment";

/** Stripe's reader status as a yes or no; anything else is "it does not say". */
const READER_ONLINE: Record<string, boolean> = { online: true, offline: false };

function toProcessorReader(reader: Stripe.Terminal.Reader): ProcessorReader {
  return {
    id: reader.id,
    label: reader.label,
    deviceType: reader.device_type ?? null,
    serialNumber: reader.serial_number ?? null,
    locationId:
      typeof reader.location === "string" ? reader.location : (reader.location?.id ?? null),
    online: READER_ONLINE[reader.status ?? ""] ?? null,
  };
}

/** Brand and last four of the card a reader read, off the PaymentIntent's charge. */
function cardPresentDetails(intent: Stripe.PaymentIntent): {
  cardLast4?: string;
  cardBrand?: string;
} {
  const charge = intent.latest_charge;
  if (!charge || typeof charge === "string") return {};
  const details = charge.payment_method_details;
  const card = details?.card_present ?? details?.interac_present;
  return { cardLast4: card?.last4 ?? undefined, cardBrand: card?.brand ?? undefined };
}

/** Stripe's "no such object" answer, as opposed to a failure to ask. */
function isMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeError && err.code === "resource_missing";
}

/**
 * A reader payment the register did not stay to see finish (the browser
 * closed, the network dropped): the same completion the register's own ask
 * would have made. The processor reference is the PaymentIntent's id. Null for
 * a PaymentIntent Holt did not send to a reader.
 */
async function readerPaymentCompletion(
  intent: Stripe.PaymentIntent,
): Promise<PaymentCompletion | null> {
  if (intent.metadata?.[READER_PAYMENT_FLAG] !== "1") return null;
  const completion: PaymentCompletion = {
    providerTxnId: intent.id,
    metadata: (intent.metadata ?? {}) as Record<string, string>,
    processorData: { paymentIntentId: intent.id, cardReader: true },
  };
  // The event's charge is an id; brand and last four are one read away, and
  // supplementary, as for a checkout.
  try {
    const stripe = await getStripe();
    const full = await stripe.paymentIntents.retrieve(intent.id, { expand: ["latest_charge"] });
    Object.assign(completion, cardPresentDetails(full));
  } catch {
    // Proceed without card details.
  }
  return completion;
}

export const stripeProvider: PaymentProvider = {
  id: "stripe",
  displayName: "Stripe",
  capabilities: { hostedCheckout: true, terminal: true, refunds: true },

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: (req.currency || "USD").toLowerCase(),
            product_data: { name: req.description },
            unit_amount: toMinorUnits(req.amount),
          },
          quantity: 1,
        },
      ],
      customer_email: req.customerEmail,
      metadata: req.metadata,
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }
    return { url: session.url, providerTxnId: session.id };
  },

  async retrieveSession(providerTxnId: string): Promise<SessionStatus> {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(providerTxnId);
    // Stripe's own vocabulary already matches the neutral shape; other
    // processors map their equivalents onto these three states.
    const status: SessionStatus["status"] =
      session.status === "complete"
        ? "complete"
        : session.status === "expired"
          ? "expired"
          : "open";
    // Intentionally returns no customer detail — see SessionStatus.
    return { status, paid: session.payment_status === "paid" };
  },

  async verifyWebhook(req: WebhookVerifyRequest): Promise<VerifiedWebhookEvent> {
    const stripe = await getStripe();
    const header = req.headers["stripe-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) {
      throw new Error("Missing stripe-signature header");
    }
    // Throws on a bad signature — the caller turns that into a 400. Verification
    // is mandatory: without it anyone can POST an event body and flip PENDING
    // payments to COMPLETED, which promotes QUOTE -> ORDER and creates POs.
    const event = stripe.webhooks.constructEvent(req.rawBody, signature, req.secret);
    return { providerId: "stripe", type: event.type, raw: event };
  },

  async extractCompletion(event: VerifiedWebhookEvent): Promise<PaymentCompletion | null> {
    if (event.type === "payment_intent.succeeded") {
      return readerPaymentCompletion(
        (event.raw as Stripe.Event).data.object as Stripe.PaymentIntent,
      );
    }

    if (event.type !== "checkout.session.completed") return null;

    const stripeEvent = event.raw as Stripe.Event;
    const session = stripeEvent.data.object as Stripe.Checkout.Session;

    const completion: PaymentCompletion = {
      providerTxnId: session.id,
      metadata: (session.metadata ?? {}) as Record<string, string>,
    };

    // Card brand/last4 need two more round-trips (session -> payment intent ->
    // charge). Supplementary only: a failure here must not block posting a
    // confirmed payment to the ledger, so it is swallowed exactly as before.
    if (session.payment_intent && typeof session.payment_intent === "string") {
      try {
        const stripe = await getStripe();
        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
        completion.processorData = { paymentIntentId: paymentIntent.id };

        if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === "string") {
          const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
          const card = charge.payment_method_details?.card;
          if (card) {
            completion.cardLast4 = card.last4 ?? undefined;
            completion.cardBrand = card.brand ?? undefined;
          }
        }
      } catch {
        // Proceed without card details.
      }
    }

    return completion;
  },

  // Fires when a customer abandons a checkout page (or it's still open when
  // the payer's card declines and they never retry) and Stripe's own
  // session lifetime — 24h — elapses. This is the PRIMARY mechanism for
  // ending a PENDING row's life; sweepStalePendingPayments (an age-based
  // sweep) exists only as a backstop for webhooks that never arrive.
  async extractExpiration(event: VerifiedWebhookEvent): Promise<PaymentExpiration | null> {
    if (event.type !== "checkout.session.expired") return null;
    const stripeEvent = event.raw as Stripe.Event;
    const session = stripeEvent.data.object as Stripe.Checkout.Session;
    return { providerTxnId: session.id };
  },

  async refund(req: RefundRequest): Promise<RefundResult> {
    const stripe = await getStripe();
    try {
      // A hosted checkout stores the CHECKOUT SESSION id, but Stripe refunds a
      // payment intent — that indirection lives here rather than in
      // paymentService, so callers just hand over whatever the original
      // payment recorded. A reader payment stored the payment intent itself.
      let paymentIntentId: string | null;
      if (req.providerTxnId.startsWith("pi_")) {
        paymentIntentId = req.providerTxnId;
      } else {
        const session = await stripe.checkout.sessions.retrieve(
          req.providerTxnId,
          {},
          REFUND_REQUEST,
        );
        paymentIntentId =
          typeof session.payment_intent === "string" ? session.payment_intent : null;
      }
      if (!paymentIntentId) return { refundId: null };

      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: toMinorUnits(req.amount),
          reason: "requested_by_customer",
          metadata: { holt_refund_key: req.idempotencyKey },
        },
        { ...REFUND_REQUEST, idempotencyKey: req.idempotencyKey },
      );
      return { refundId: refund.id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Stripe refund failed";
      throw new Error(`Stripe refund failed: ${msg}`);
    }
  },

  async createTerminalCheckout(req: TerminalCheckoutRequest): Promise<TerminalCheckoutResult> {
    const stripe = await getStripe();
    const intent = await stripe.paymentIntents.create({
      amount: toMinorUnits(req.amount),
      currency: (req.currency || "USD").toLowerCase(),
      payment_method_types: ["card_present"],
      // One step: an approved card is a taken payment. Nothing in Holt
      // authorizes now and captures later.
      capture_method: "automatic",
      description: req.referenceId,
      metadata: { ...req.metadata, [READER_PAYMENT_FLAG]: "1" },
    });
    try {
      await stripe.terminal.readers.processPaymentIntent(req.deviceId, {
        payment_intent: intent.id,
      });
    } catch (err) {
      // The reader never took it (offline, busy, unknown): leave nothing
      // payable behind, then say why.
      await stripe.paymentIntents.cancel(intent.id).catch(() => undefined);
      throw err;
    }
    return { providerTxnId: intent.id, status: "PENDING" };
  },

  async getTerminalCheckout(
    providerTxnId: string,
    deviceId?: string,
  ): Promise<TerminalCheckoutResult> {
    const stripe = await getStripe();
    const intent = await stripe.paymentIntents.retrieve(providerTxnId, {
      expand: ["latest_charge"],
    });
    const base = { providerTxnId: intent.id };
    if (intent.status === "succeeded") {
      return {
        ...base,
        status: "COMPLETED",
        ...cardPresentDetails(intent),
        processorData: { paymentIntentId: intent.id, cardReader: true, readerId: deviceId },
      };
    }
    if (intent.status === "canceled") return { ...base, status: "CANCELED" };
    // A declined card leaves the intent waiting for another card, with why.
    if (intent.status === "requires_payment_method" && intent.last_payment_error) {
      return {
        ...base,
        status: "FAILED",
        message: intent.last_payment_error.message ?? "The card was declined.",
      };
    }
    // Otherwise the reader says whether it is still working on this payment.
    if (deviceId) {
      const reader = await stripe.terminal.readers.retrieve(deviceId);
      const action = "deleted" in reader ? null : reader.action;
      const actionIntent = action?.process_payment_intent?.payment_intent;
      const actionIntentId = typeof actionIntent === "string" ? actionIntent : actionIntent?.id;
      if (action && actionIntentId === intent.id && action.status === "failed") {
        return {
          ...base,
          status: "FAILED",
          message: action.failure_message ?? "The reader could not take the payment.",
        };
      }
    }
    return { ...base, status: "PENDING" };
  },

  async cancelTerminalCheckout(providerTxnId: string, deviceId?: string): Promise<void> {
    const stripe = await getStripe();
    // Both refuse once a card is being authorized or the payment is taken.
    // Neither refusal is an error here: the caller reads the outcome next.
    if (deviceId) {
      await stripe.terminal.readers.cancelAction(deviceId).catch(() => undefined);
    }
    await stripe.paymentIntents.cancel(providerTxnId).catch(() => undefined);
  },

  async listReaderLocations(): Promise<ReaderLocation[]> {
    const stripe = await getStripe();
    const locations = await stripe.terminal.locations.list({ limit: 100 });
    return locations.data.map((l) => ({ id: l.id, name: l.display_name || l.id }));
  },

  async createReaderLocation(input: ReaderLocationInput): Promise<ReaderLocation> {
    const stripe = await getStripe();
    const location = await stripe.terminal.locations.create({
      display_name: input.name,
      address: {
        line1: input.line1,
        city: input.city,
        state: input.state,
        postal_code: input.postalCode,
        country: input.country,
      },
    });
    return { id: location.id, name: location.display_name || location.id };
  },

  async registerReader(req: RegisterReaderRequest): Promise<ProcessorReader> {
    const stripe = await getStripe();
    const reader = await stripe.terminal.readers.create({
      registration_code: req.registrationCode,
      label: req.label,
      location: req.locationId,
    });
    return toProcessorReader(reader);
  },

  async getReader(readerId: string): Promise<ProcessorReader | null> {
    const stripe = await getStripe();
    try {
      const reader = await stripe.terminal.readers.retrieve(readerId);
      return "deleted" in reader ? null : toProcessorReader(reader);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },

  async removeReader(readerId: string): Promise<void> {
    const stripe = await getStripe();
    try {
      await stripe.terminal.readers.del(readerId);
    } catch (err) {
      // Already gone at Stripe is the state being asked for.
      if (!isMissing(err)) throw err;
    }
  },

  async simulateCardPresented(readerId: string): Promise<void> {
    const stripe = await getStripe();
    await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
  },

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const stripe = await getStripe();
      const balance = await stripe.balance.retrieve();
      return { ok: true, message: `Connected. ${balance.available.length} balance bucket(s).` };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : "Stripe test failed" };
    }
  },

  // getStripe throws exactly when no secret key resolves; building the client
  // makes no request.
  async isConfigured(): Promise<boolean> {
    try {
      await getStripe();
      return true;
    } catch {
      return false;
    }
  },
};
