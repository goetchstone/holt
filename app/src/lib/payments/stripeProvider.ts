// /app/src/lib/payments/stripeProvider.ts
//
// Stripe behind the provider seam. This is a REWIRING, not a rewrite: every
// behaviour here is lifted from the call sites it replaces
// (lib/billing/invoiceStripe.ts, pages/api/stripe/{webhook,create-checkout,
// send-payment-link}.ts, lib/paymentService.ts::processRefund), including the
// pinned API version and the two-hop retrieve used to recover card brand/last4.
//
// Terminal is declared UNSUPPORTED here on purpose. Stripe Terminal is a
// client-driven SDK flow (the browser holds the reader connection and asks the
// server only for a connection token) — it does not fit the server-driven
// methods on this interface, and pretending otherwise would produce a method
// that cannot work. Square's readers are server-driven and do fit.

import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import type {
  CheckoutRequest,
  CheckoutResult,
  ConnectionTestResult,
  PaymentCompletion,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  SessionStatus,
  VerifiedWebhookEvent,
  WebhookVerifyRequest,
} from "@/lib/payments/types";

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export const stripeProvider: PaymentProvider = {
  id: "stripe",
  displayName: "Stripe",
  capabilities: { hostedCheckout: true, terminal: false, refunds: true },

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

  async refund(req: RefundRequest): Promise<RefundResult> {
    const stripe = await getStripe();
    try {
      // Holt stores the CHECKOUT SESSION id, but Stripe refunds a payment
      // intent — that indirection lives here rather than in paymentService, so
      // callers just hand over whatever the original payment recorded.
      const session = await stripe.checkout.sessions.retrieve(req.providerTxnId);
      const paymentIntentId =
        typeof session.payment_intent === "string" ? session.payment_intent : null;
      if (!paymentIntentId) return { refundId: null };

      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount: toMinorUnits(req.amount),
        reason: "requested_by_customer",
      });
      return { refundId: refund.id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Stripe refund failed";
      throw new Error(`Stripe refund failed: ${msg}`);
    }
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
};
