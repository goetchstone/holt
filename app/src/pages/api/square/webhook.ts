// /app/src/pages/api/square/webhook.ts
//
// Modelled directly on pages/api/stripe/webhook.ts. The downstream ledger-
// posting logic (completePayment, onPaymentReceived, applyInvoiceStripePayment)
// is provider-neutral despite the name of that last function -- it posts off
// Payment.invoiceId, never anything Stripe-specific -- so it is reused
// as-is rather than duplicated. Everything above that line is where the two
// routes differ: Square signs the notification URL + raw body (not a single
// header value), so verifyWebhook needs the absolute URL Square delivered to,
// which this route builds the same way create-checkout.ts builds baseUrl.

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

  // This route is Square's delivery endpoint, so it resolves the Square
  // provider explicitly -- same shape as the Stripe route resolving "stripe".
  const provider = getPaymentProvider("square");
  const rawBody = await buffer(req);
  const webhookSecret =
    (await resolveCredential("square", "webhookSignatureKey", "SQUARE_WEBHOOK_SIGNATURE_KEY")) ??
    "";

  // Signature verification is mandatory. Without it, an attacker can POST any
  // event body and mark PENDING payments as COMPLETED, which triggers
  // onPaymentReceived (promotes QUOTE → ORDER, creates POs).
  if (!webhookSecret) {
    logError(
      "Square webhook received but no webhook signature key is configured; rejecting",
      new Error("Missing Square webhook signature key"),
    );
    return res.status(500).json({ error: "Webhook signature key not configured" });
  }

  // Square signs against the notification URL configured in its dashboard --
  // an absolute URL, not the bare path Next.js hands back on req.url. Built
  // the same way create-checkout.ts derives baseUrl; NEXTAUTH_URL must match
  // whatever's registered as the notification URL for this to verify.
  const baseUrl = (process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
  const requestUrl = `${baseUrl}${req.url ?? "/api/square/webhook"}`;

  let completion;
  try {
    const event = await provider.verifyWebhook!({
      rawBody,
      headers: req.headers,
      secret: webhookSecret,
      requestUrl,
    });
    completion = await provider.extractCompletion!(event);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Signature verification failed";
    return res.status(400).json({ error: message });
  }

  // Authentic event, but not a completion (Square sends many event types).
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
      // Card details were resolved by the provider (supplementary -- absent
      // if Square didn't return card_details, which must not block posting
      // the confirmed charge).
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
      // the money has moved at Square but our ledger is out of sync -- the
      // most important failure to surface. Alert, then 500 so Square retries;
      // every step below is idempotent, so a retry re-runs cleanly once fixed.
      try {
        // Flip to COMPLETED and post the AR-ledger entry atomically -- the
        // charge is only now confirmed. Idempotent if the webhook re-fires.
        await completePayment(pendingPayment.id, extraData);

        // Promote QUOTE → ORDER and create draft POs
        if (pendingPayment.salesOrderId) {
          await onPaymentReceived(pendingPayment.salesOrderId);
        }

        // Authored-invoice payment: apply to the invoice + post the
        // AR_PAYMENT journal. Provider-neutral despite the name (it posts off
        // Payment.invoiceId, never anything Stripe-specific) -- reused as-is
        // rather than duplicated. Routing is structural (Payment.invoiceId,
        // set at link creation); the metadata id is only a cross-check -- a
        // mismatch throws, Square retries, and completePayment above stays a
        // no-op, so the application lands once the discrepancy is investigated.
        if (pendingPayment.invoiceId !== null || invoiceId) {
          await applyInvoiceStripePayment(
            pendingPayment.id,
            invoiceId ? Number(invoiceId) : undefined,
          );
        }
      } catch (err) {
        logError("Square webhook: failed to post confirmed payment to the ledger", err, {
          paymentId: pendingPayment.id,
          orderId: completion.providerTxnId,
        });
        await reportOpsAlert({
          title: "Square payment received but not posted to the ledger",
          detail:
            "A charge completed at Square but the AR/ledger post failed. The books are out of sync until this is resolved; Square will retry the webhook.",
          context: {
            paymentId: pendingPayment.id,
            squareOrderId: completion.providerTxnId,
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
