// /app/src/pages/api/stripe/send-payment-link.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { resolveCheckoutEmail } from "@/lib/stripe";
import { assertCapability, getActiveProvider } from "@/lib/payments";
import {
  calculateOrderBalance,
  findActivePendingPayment,
  voidPendingPayment,
} from "@/lib/paymentService";

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

    // A PENDING row from a link the customer may still be sitting on —
    // sending a second one risks both landing (double-charge). Refuse with
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
        reason: "Replaced by a new payment link (force)",
      });
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

    // Whichever processor the deployment has made active takes new payments.
    const provider = getActiveProvider();
    assertCapability(provider, "hostedCheckout");

    const checkout = await provider.createCheckout!({
      amount: paymentAmount,
      currency: "USD",
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
      successUrl: `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/app/payment/cancel?order_id=${orderId}`,
    });

    // Create a PENDING payment record for tracking
    await prisma.payment.create({
      data: {
        salesOrderId: orderId,
        paymentDate: new Date(),
        paymentType: isDeposit ? "Deposit" : "Card",
        paymentAmount: paymentAmount,
        status: "PENDING",
        method: "CARD",
        processorType: provider.id.toUpperCase(),
        processorTxnId: checkout.providerTxnId,
        createdBy: session.user?.email || undefined,
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
    const message = error instanceof Error ? error.message : "Failed to create payment link";
    return res.status(500).json({ error: message });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
