// /app/src/pages/api/stripe/webhook.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getPaymentProvider } from "@/lib/payments";
import type { PaymentExpiration } from "@/lib/payments/types";
import { resolveCredential } from "@/lib/integrationCredentials";
import { prisma } from "@/lib/prisma";
import {
  completePayment,
  expirePendingPayment,
  followUpWebhookPayment,
  reportUntrackedCheckoutPaid,
} from "@/lib/paymentService";
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
  let expiration: PaymentExpiration | null = null;
  try {
    const event = await provider.verifyWebhook!({
      rawBody,
      headers: req.headers,
      secret: webhookSecret,
      requestUrl: req.url,
    });
    completion = await provider.extractCompletion!(event);
    // Only worth checking when this event wasn't a completion — the two are
    // mutually exclusive per event, and extractExpiration is optional (see
    // squareProvider.ts, which doesn't implement it at all).
    if (!completion && provider.extractExpiration) {
      expiration = await provider.extractExpiration(event);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Signature verification failed";
    return res.status(400).json({ error: message });
  }

  // Authentic event, and it's the processor telling us a hosted checkout
  // expired without being paid — end the PENDING row's life so it stops
  // blocking re-charge attempts (findActivePendingPayment) and stops
  // reading as "in progress" forever. No ledger entry: recordPendingPayment
  // never posted one, so there's nothing to reverse. Unlike the completion
  // path below, a failure here does NOT need Stripe to retry via a 500 —
  // sweepStalePendingPayments will catch this row anyway once it goes
  // stale, so a transient error just means the sweep gets there instead of
  // the webhook.
  if (expiration) {
    const pendingPayment = await prisma.payment.findFirst({
      where: { processorTxnId: expiration.providerTxnId, status: "PENDING" },
    });
    if (pendingPayment) {
      try {
        await expirePendingPayment(pendingPayment.id);
      } catch (err) {
        logError("Stripe webhook: failed to expire a stale PENDING payment", err, {
          paymentId: pendingPayment.id,
          sessionId: expiration.providerTxnId,
        });
      }
    }
    return res.status(200).json({ received: true });
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

      // The charge is confirmed; now post it to the books. If that throws, the
      // money has moved at Stripe but isn't in our books -- the most important
      // failure to surface. Alert, then 500 so Stripe retries.
      let completed: Awaited<ReturnType<typeof completePayment>>;
      try {
        // One transaction: COMPLETED, the AR-ledger entry, an order's gift
        // cards, and an invoice's application and AR_PAYMENT journal. A
        // failure writes none of it and leaves the row PENDING (marked paid at
        // the processor, so the stale sweep leaves it), and Stripe's retry
        // finds it and posts it whole. Routing is structural
        // (Payment.invoiceId, set at link creation); the metadata id is only a
        // cross-check, and a mismatch refuses the completion on every retry,
        // for a person to resolve. (#137)
        completed = await completePayment(pendingPayment.id, extraData, {
          metadataInvoiceId: invoiceId ? Number(invoiceId) : undefined,
        });
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

      if (!completed) {
        // Another delivery completed it first (silent), or it was voided or
        // expired meanwhile: money Holt stopped tracking (alert).
        await reportUntrackedCheckoutPaid(completion.providerTxnId, provider.displayName);
      } else if (completed.salesOrderId) {
        // Promote QUOTE → ORDER and create draft POs. Not money, and not
        // retried (a retry finds the row COMPLETED): a failure is alerted.
        await followUpWebhookPayment(completed.salesOrderId, provider.displayName, {
          paymentId: completed.id,
          sessionId: completion.providerTxnId,
        });
      }
    } else {
      // No PENDING row: a retry of a completed one (silent), or a session Holt
      // stopped tracking that the customer paid anyway (alert).
      await reportUntrackedCheckoutPaid(completion.providerTxnId, provider.displayName);
    }
  }

  return res.status(200).json({ received: true });
}
