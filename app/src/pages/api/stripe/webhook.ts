// /app/src/pages/api/stripe/webhook.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getPaymentProvider } from "@/lib/payments";
import { resolveCredential } from "@/lib/integrationCredentials";
import { prisma } from "@/lib/prisma";
import { completePayment, onPaymentReceived } from "@/lib/paymentService";
import { applyInvoiceStripePayment } from "@/lib/billing/invoiceService";
import { logError } from "@/lib/logger";
import { reportOpsAlert } from "@/lib/opsAlert";

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

  // This route is Stripe's delivery endpoint, so it resolves the Stripe
  // provider explicitly. Verification and event parsing happen behind the
  // seam — Square HMACs the notification URL + body rather than signing a
  // header, so each provider owns its own mechanism.
  const provider = getPaymentProvider("stripe");
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

  let completion;
  try {
    const event = await provider.verifyWebhook!({
      rawBody,
      headers: req.headers,
      secret: webhookSecret,
      requestUrl: req.url,
    });
    completion = await provider.extractCompletion!(event);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Signature verification failed";
    return res.status(400).json({ error: message });
  }

  // Authentic event, but not a completion (processors send many event types).
  if (completion) {
    const orderId = completion.metadata.orderId;
    const invoiceId = completion.metadata.invoiceId;

    if (!orderId && !invoiceId) {
      return res.status(200).json({ received: true, warning: "No orderId/invoiceId in metadata" });
    }

    const pendingPayment = await prisma.payment.findFirst({
      where: {
        processorTxnId: completion.providerTxnId,
        status: "PENDING",
      },
    });

    if (pendingPayment) {
      // Card details were resolved by the provider (supplementary — absent if
      // the processor lookup failed, which must not block posting the charge).
      const extraData: {
        processorData?: Record<string, unknown>;
        cardLast4?: string;
        cardBrand?: string;
      } = {
        processorData: completion.processorData,
        cardLast4: completion.cardLast4,
        cardBrand: completion.cardBrand,
      };

      // The charge is confirmed; now post it to the books. If any step throws,
      // the money has moved at Stripe but our ledger is out of sync — the most
      // important failure to surface. Alert, then 500 so Stripe retries; every
      // step below is idempotent, so a retry re-runs cleanly once fixed.
      try {
        // Flip to COMPLETED and post the AR-ledger entry atomically — the charge
        // is only now confirmed. Idempotent if the webhook re-fires. (#137)
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
      } catch (err) {
        logError("Stripe webhook: failed to post confirmed payment to the ledger", err, {
          paymentId: pendingPayment.id,
          sessionId: completion.providerTxnId,
        });
        await reportOpsAlert({
          title: "Stripe payment received but not posted to the ledger",
          detail:
            "A charge completed at Stripe but the AR/ledger post failed. The books are out of sync until this is resolved; Stripe will retry the webhook.",
          context: {
            paymentId: pendingPayment.id,
            sessionId: completion.providerTxnId,
            orderId: orderId ?? null,
            invoiceId: invoiceId ?? pendingPayment.invoiceId ?? null,
          },
        });
        return res.status(500).json({ error: "Failed to post payment to the ledger" });
      }
    }
  }

  return res.status(200).json({ received: true });
}
