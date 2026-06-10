// /app/src/pages/api/stripe/webhook.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getStripe } from "@/lib/stripe";
import { resolveCredential } from "@/lib/integrationCredentials";
import { prisma } from "@/lib/prisma";
import { completePayment, onPaymentReceived } from "@/lib/paymentService";
import { applyInvoiceStripePayment } from "@/lib/billing/invoiceService";
import { logError } from "@/lib/logger";
import type Stripe from "stripe";

export const config = { api: { bodyParser: false } };

async function buffer(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripe = await getStripe();
  const rawBody = await buffer(req);
  const webhookSecret =
    (await resolveCredential("stripe", "webhookSecret", "STRIPE_WEBHOOK_SECRET")) ?? "";

  // Signature verification is mandatory. Without it, an attacker can
  // POST any event body and mark PENDING payments as COMPLETED, which
  // triggers onPaymentReceived (promotes QUOTE → ORDER, creates POs).
  if (!webhookSecret) {
    logError(
      "Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set; rejecting",
      new Error("Missing STRIPE_WEBHOOK_SECRET"),
    );
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).json({ error: "Missing stripe-signature header" });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Signature verification failed";
    return res.status(400).json({ error: message });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.orderId;
    const invoiceId = session.metadata?.invoiceId;

    if (!orderId && !invoiceId) {
      return res.status(200).json({ received: true, warning: "No orderId/invoiceId in metadata" });
    }

    const pendingPayment = await prisma.payment.findFirst({
      where: {
        processorTxnId: session.id,
        status: "PENDING",
      },
    });

    if (pendingPayment) {
      const extraData: {
        processorData?: Record<string, unknown>;
        cardLast4?: string;
        cardBrand?: string;
      } = {};

      // Retrieve payment intent for card details if available
      if (session.payment_intent && typeof session.payment_intent === "string") {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
          extraData.processorData = { paymentIntentId: paymentIntent.id };

          if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === "string") {
            const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
            if (charge.payment_method_details?.card) {
              extraData.cardLast4 = charge.payment_method_details.card.last4 ?? undefined;
              extraData.cardBrand = charge.payment_method_details.card.brand ?? undefined;
            }
          }
        } catch {
          // Card details are supplementary; proceed without them
        }
      }

      // Flip to COMPLETED and post the AR-ledger entry atomically — the charge is
      // only now confirmed. Idempotent if the webhook re-fires. (#137)
      await completePayment(pendingPayment.id, extraData);

      // Promote QUOTE → ORDER and create draft POs
      if (pendingPayment.salesOrderId) {
        await onPaymentReceived(pendingPayment.salesOrderId);
      }

      // Authored-invoice payment: apply to the invoice + post the AR_PAYMENT
      // journal. Routing is structural (Payment.invoiceId, set at link
      // creation); the metadata id is only a cross-check — a mismatch throws,
      // Stripe retries, and completePayment above stays a no-op, so the
      // application lands once the discrepancy is investigated.
      if (pendingPayment.invoiceId !== null || invoiceId) {
        await applyInvoiceStripePayment(
          pendingPayment.id,
          invoiceId ? Number(invoiceId) : undefined,
        );
      }
    }
  }

  return res.status(200).json({ received: true });
}
