// /app/src/pages/api/stripe/create-checkout.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import {
  calculateOrderBalance,
  CheckoutAlreadyOpenError,
  startHostedCheckout,
} from "@/lib/paymentService";
import { logError } from "@/lib/logger";

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

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

    // Refuses with a 409 while a checkout on this order may still be open
    // (both could land: a double charge), unless the operator confirmed a
    // replacement with force.
    const checkout = await startHostedCheckout({
      target: { orderId },
      amount: balance.balanceDue,
      actor: session.user?.email,
      force,
      description: `Order ${order.orderno}`,
      customerEmail: order.customer?.email || undefined,
      metadata: {
        orderId: order.id.toString(),
        orderno: order.orderno,
      },
      urls: {
        successUrl: successUrl || `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: cancelUrl || `${baseUrl}/app/payment/cancel?order_id=${orderId}`,
      },
    });

    return res.status(200).json({
      url: checkout.url,
      sessionId: checkout.providerTxnId,
    });
  } catch (error: unknown) {
    if (error instanceof CheckoutAlreadyOpenError) {
      return res.status(409).json({ error: error.message, existingPayment: error.existing });
    }
    logError("Checkout session creation failed", error, { orderId });
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
