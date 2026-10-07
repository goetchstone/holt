// /app/src/lib/payments/squareProvider.ts
//
// Square behind the provider seam. Online payments only for this PR (hosted
// checkout, webhook, refunds, status polling, test connection) -- Terminal
// (card-present) is a separate follow-up, so `terminal: false` here is an
// honest capability, not a placeholder. Square's readers ARE server-driven
// (POST a terminal checkout, poll for the result) and so DO fit this
// interface's server-driven terminal methods, unlike Stripe's client-driven
// SDK -- see stripeProvider.ts. That's future work, not this file.
//
// Talks to Square over `fetch` (see lib/square.ts for the SDK-vs-REST
// decision) rather than the official `square` npm package.

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { getSquareCredentials, squareRequest } from "@/lib/square";
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

/** Amounts cross the seam in MAJOR units (dollars); Square wants minor units
 *  (cents), same conversion stripeProvider does for Stripe. Exported so the
 *  conversion is directly unit-testable per CLAUDE.md rule 14 ("test the
 *  logic, not the wrapper") rather than only reachable through a network call. */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/** Square Order.state -> the neutral SessionStatus vocabulary. Pure and
 *  exported for the same reason as toMinorUnits: testable without a live
 *  Orders API call. "expired" covers CANCELED, the closest analog to a Stripe
 *  checkout session a payer walked away from. */
export function mapOrderStateToStatus(state: string | undefined): SessionStatus["status"] {
  if (state === "COMPLETED") return "complete";
  if (state === "CANCELED") return "expired";
  return "open";
}

// --- Square's wire shapes, narrowed to only the fields this file reads. ---

interface SquareMoney {
  amount?: number;
  currency?: string;
}

interface SquarePaymentLink {
  id: string;
  url: string;
  order_id: string;
}

interface SquareOrder {
  state?: string;
  total_money?: SquareMoney;
  metadata?: Record<string, string>;
  tenders?: { payment_id?: string }[];
}

interface SquareCard {
  card_brand?: string;
  last_4?: string;
}

interface SquarePayment {
  id: string;
  order_id: string;
  status?: string; // APPROVED | PENDING | COMPLETED | CANCELED | FAILED
  card_details?: { card?: SquareCard };
}

interface SquareWebhookEnvelope {
  type: string;
  data?: { object?: { payment?: SquarePayment } };
}

export const squareProvider: PaymentProvider = {
  id: "square",
  displayName: "Square",
  capabilities: { hostedCheckout: true, terminal: false, refunds: true },

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const { locationId } = await getSquareCredentials();

    // Square's Checkout API creates the Order and the hosted payment link in
    // one call. There is no separate "cancel" URL the way Stripe has one --
    // Payment Links only redirect on completion, so req.cancelUrl has no
    // Square equivalent and is intentionally unused here.
    const { payment_link } = await squareRequest<{ payment_link: SquarePaymentLink }>(
      "/v2/online-checkout/payment-links",
      {
        method: "POST",
        body: {
          idempotency_key: randomUUID(),
          order: {
            location_id: locationId,
            line_items: [
              {
                name: req.description,
                quantity: "1",
                base_price_money: {
                  amount: toMinorUnits(req.amount),
                  currency: (req.currency || "USD").toUpperCase(),
                },
              },
            ],
            // Echoed back on GET /v2/orders/{id} -- read back in
            // extractCompletion, since the payment.updated webhook carries
            // order_id but not the order's own metadata map.
            metadata: req.metadata,
          },
          checkout_options: {
            redirect_url: req.successUrl,
          },
          pre_populated_data: req.customerEmail ? { buyer_email: req.customerEmail } : undefined,
        },
      },
    );

    if (!payment_link?.url || !payment_link?.order_id) {
      throw new Error("Square did not return a checkout URL");
    }
    // The Order id is the only stable identifier that exists at this point --
    // no Square Payment exists yet. This is what gets persisted on
    // Payment.processorTxnId (see recordPendingPayment call sites) and is
    // exactly the constraint that makes Stripe store a checkout SESSION id
    // instead of a payment intent id. See refund() below for the
    // order -> payment resolution this implies down the line.
    return { url: payment_link.url, providerTxnId: payment_link.order_id };
  },

  async retrieveSession(providerTxnId: string): Promise<SessionStatus> {
    const { order } = await squareRequest<{ order: SquareOrder }>(`/v2/orders/${providerTxnId}`);
    const status = mapOrderStateToStatus(order.state);
    // Intentionally returns no customer detail -- see SessionStatus. An order
    // only reaches Square's COMPLETED state once fully tendered, so "complete"
    // and "paid" coincide for a single hosted-checkout payment link.
    return { status, paid: status === "complete" };
  },

  async verifyWebhook(req: WebhookVerifyRequest): Promise<VerifiedWebhookEvent> {
    const header = req.headers["x-square-hmacsha256-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) {
      throw new Error("Missing x-square-hmacsha256-signature header");
    }
    if (!req.requestUrl) {
      throw new Error("Square webhook verification requires the notification URL");
    }

    // Square HMAC-SHA256s the notification URL concatenated with the raw
    // request body, base64-encodes the digest, and sends it in
    // x-square-hmacsha256-signature. Verification is mandatory for the same
    // reason as Stripe's: without it anyone can POST an event body and flip
    // PENDING payments to COMPLETED, which promotes QUOTE -> ORDER and
    // creates POs.
    const expected = createHmac("sha256", req.secret)
      .update(req.requestUrl + req.rawBody.toString("utf8"))
      .digest("base64");

    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(signature, "utf8");
    // timingSafeEqual throws on a length mismatch rather than returning
    // false, so check lengths first -- a length mismatch is itself a
    // legitimate "signatures don't match" outcome, not a crash.
    const matches =
      expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
    if (!matches) {
      throw new Error("Square webhook signature verification failed");
    }

    const event = JSON.parse(req.rawBody.toString("utf8")) as SquareWebhookEnvelope;
    return { providerId: "square", type: event.type, raw: event };
  },

  async extractCompletion(event: VerifiedWebhookEvent): Promise<PaymentCompletion | null> {
    // A completed card payment can arrive as either type depending on
    // whether Square captures it immediately; gate on payment.status rather
    // than trusting the event type alone.
    if (event.type !== "payment.created" && event.type !== "payment.updated") return null;

    const envelope = event.raw as SquareWebhookEnvelope;
    const payment = envelope.data?.object?.payment;
    if (!payment || payment.status !== "COMPLETED") return null;

    // Payment Links don't echo the order's metadata onto the Payment object
    // the webhook carries -- only order_id. Unlike stripeProvider's
    // supplementary card-detail lookup (swallowed on failure), this fetch is
    // NOT optional: metadata is how the webhook route finds the orderId /
    // invoiceId to post to, so a failure here must propagate rather than
    // silently post an unrouted completion.
    const { order } = await squareRequest<{ order: SquareOrder }>(`/v2/orders/${payment.order_id}`);

    const completion: PaymentCompletion = {
      // Matches what createCheckout stored on Payment.processorTxnId (the
      // order id) -- required for the webhook route's
      // `processorTxnId: completion.providerTxnId` lookup to find the
      // pending row.
      providerTxnId: payment.order_id,
      metadata: order.metadata ?? {},
      processorData: { paymentId: payment.id },
    };

    const card = payment.card_details?.card;
    if (card) {
      completion.cardLast4 = card.last_4 ?? undefined;
      completion.cardBrand = card.card_brand ?? undefined;
    }

    return completion;
  },

  // No extractExpiration here, deliberately. Square's Checkout API payment
  // links don't emit a distinct "this link expired" webhook event the way
  // Stripe's checkout.session.expired does -- an abandoned Payment Link's
  // Order just stays in whatever state it was in (see mapOrderStateToStatus
  // above, which already treats Square's CANCELED as the closest analog for
  // the POLLING path). Rather than guess at an event type Square doesn't
  // document, this provider leaves the method undefined; the webhook route
  // treats a missing extractExpiration as "this provider never signals
  // expiration" and relies entirely on the age-based sweeper
  // (paymentService.sweepStalePendingPayments) to close out abandoned Square
  // PENDING rows after PENDING_SESSION_LIFETIME_MS.

  async refund(req: RefundRequest): Promise<RefundResult> {
    try {
      // Payment.processorTxnId holds the Square ORDER id (stamped at
      // checkout-creation time -- see createCheckout), not a payment id, so
      // resolving order -> payment is unavoidable no matter which id gets
      // persisted at creation; Stripe has the identical constraint (session
      // -> payment intent). The order's `tenders` array is Square's
      // documented order-to-payment link (Tender.payment_id). Once resolved,
      // Square's Refunds API takes that payment id directly in one call --
      // there's no second "resolve the charge from the intent" hop the way
      // Stripe's payment-intent -> charge chain needs for card details.
      const { order } = await squareRequest<{ order: SquareOrder }>(
        `/v2/orders/${req.providerTxnId}`,
      );
      const paymentId = order.tenders?.[0]?.payment_id;
      if (!paymentId) return { refundId: null };

      const { refund } = await squareRequest<{ refund: { id: string } }>("/v2/refunds", {
        method: "POST",
        body: {
          idempotency_key: randomUUID(),
          payment_id: paymentId,
          amount_money: {
            amount: toMinorUnits(req.amount),
            currency: order.total_money?.currency || "USD",
          },
          reason: req.reason,
        },
      });
      return { refundId: refund.id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Square refund failed";
      throw new Error(`Square refund failed: ${msg}`);
    }
  },

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const { locations } = await squareRequest<{ locations?: { id: string }[] }>("/v2/locations");
      return { ok: true, message: `Connected. ${locations?.length ?? 0} location(s) available.` };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : "Square test failed" };
    }
  },
};
