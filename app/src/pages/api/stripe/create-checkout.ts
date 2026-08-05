// /app/src/pages/api/stripe/create-checkout.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { assertCapability, getActiveProvider } from "@/lib/payments";
import {
  calculateOrderBalance,
  findActivePendingPayment,
  recordPendingPayment,
  voidPendingPayment,
} from "@/lib/paymentService";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { orderId, successUrl, cancelUrl, force } = req.body as {
    orderId: number;
    successUrl?: string;
    cancelUrl?: string;
    /** Void an already-open PENDING checkout and replace it. See
     *  findActivePendingPayment — for when a customer says the earlier link
     *  never arrived. */
    force?: boolean;
  };

  if (!orderId) {
    return res.status(400).json({ error: "orderId is required" });
  }

  try {
    const order = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        customer: { select: { email: true, firstName: true, lastName: true } },
        lineItems: { select: { productName: true } },
      },
    });

    const balance = await calculateOrderBalance(orderId);

    if (balance.balanceDue <= 0) {
      return res.status(400).json({ error: "No balance due on this order" });
    }

    // A PENDING row from a checkout the customer may still be sitting on —
    // starting a second one risks both landing (double-charge). Refuse with
    // enough detail that the operator can tell "still open" from "actually
    // failed," unless they've explicitly confirmed a replacement.
    const existingPending = await findActivePendingPayment(orderId);
    if (existingPending) {
      if (!force) {
        return res.status(409).json({
          error:
            `A payment link for $${existingPending.amount.toFixed(2)} is already open on ` +
            `this order (started ${existingPending.ageMinutes} min ago). If the customer says ` +
            `it never arrived, retry with force:true to void it and send a new one.`,
          existingPayment: existingPending,
        });
      }
      await voidPendingPayment(existingPending.id, {
        voidedBy: session.user?.email,
        reason: "Replaced by a new checkout (force)",
      });
    }

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const description = `Order ${order.orderno}`;

    // Whichever processor the deployment has made active takes new payments.
    const provider = getActiveProvider();
    assertCapability(provider, "hostedCheckout");

    const checkout = await provider.createCheckout!({
      amount: balance.balanceDue,
      currency: "USD",
      description,
      customerEmail: order.customer?.email || undefined,
      metadata: {
        orderId: order.id.toString(),
        orderno: order.orderno,
      },
      successUrl: successUrl || `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: cancelUrl || `${baseUrl}/app/payment/cancel?order_id=${orderId}`,
    });

    // PENDING + no ledger entry yet. The AR-ledger entry is posted only when the
    // webhook confirms the charge (completePayment), so an abandoned checkout
    // leaves nothing in the books. (#137)
    await recordPendingPayment(orderId, {
      method: "CARD",
      amount: balance.balanceDue,
      processorType: provider.id.toUpperCase(),
      processorTxnId: checkout.providerTxnId,
      createdBy: session.user?.email || undefined,
    });

    return res.status(200).json({
      url: checkout.url,
      sessionId: checkout.providerTxnId,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create checkout session";
    return res.status(500).json({ error: message });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
