// /app/src/pages/api/stripe/send-payment-link.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { resolveCheckoutEmail } from "@/lib/stripe";
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

  const {
    orderId,
    amount: requestedAmount,
    force,
  } = req.body as {
    orderId: number;
    amount?: number;
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
        lineItems: {
          select: { productName: true, partNo: true, netPrice: true, orderedQuantity: true },
        },
      },
    });

    if (!order.customer) {
      return res
        .status(400)
        .json({ error: "This order has no customer on file; cannot send a payment link." });
    }

    const balance = await calculateOrderBalance(orderId);

    if (balance.balanceDue <= 0) {
      return res.status(400).json({ error: "No balance due on this order" });
    }

    // Use requested amount if provided, otherwise full balance
    const paymentAmount = requestedAmount
      ? Math.min(requestedAmount, balance.balanceDue)
      : balance.balanceDue;

    if (paymentAmount <= 0) {
      return res.status(400).json({ error: "Payment amount must be greater than zero" });
    }

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

    // Build line item description for the checkout page
    const isDeposit = paymentAmount < balance.balanceDue;
    const productName = isDeposit
      ? `Deposit - Order ${order.orderno}`
      : `Balance Due - Order ${order.orderno}`;

    const description = order.lineItems
      .slice(0, 5)
      .map((li) => li.productName || li.partNo || "Item")
      .join(", ");

    // A link the customer may still be sitting on refuses with a 409: sending
    // a second risks both landing (a double charge), unless the operator
    // confirmed a replacement with force.
    const checkout = await startHostedCheckout({
      target: { orderId },
      amount: paymentAmount,
      actor: session.user?.email,
      force,
      // The seam models one line-item label (stripeProvider.createCheckout uses
      // it as product_data.name); fold the item-list detail Stripe used to show
      // as a separate `description` into the same string rather than dropping it.
      description: description ? `${productName} — ${description}` : productName,
      customerEmail: resolveCheckoutEmail(order.customer.email),
      metadata: {
        orderId: order.id.toString(),
        orderno: order.orderno,
        storeLocation: order.storeLocation || "",
        isDeposit: isDeposit.toString(),
        requestedBy: session.user?.email || "",
      },
      urls: {
        successUrl: `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/app/payment/cancel?order_id=${orderId}`,
      },
    });

    return res.status(200).json({
      url: checkout.url,
      amount: paymentAmount,
      balanceDue: balance.balanceDue,
      isDeposit,
      customerEmail: resolveCheckoutEmail(order.customer.email),
    });
  } catch (error: unknown) {
    if (error instanceof CheckoutAlreadyOpenError) {
      return res.status(409).json({ error: error.message, existingPayment: error.existing });
    }
    logError("Payment link creation failed", error, { orderId });
    return res.status(500).json({ error: "Failed to create payment link" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
