// /app/src/pages/api/portal/pay.ts
//
// Portal-facing payment endpoint. Uses JWT token auth (no session required).
// Creates a Stripe checkout session for the specified amount.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { resolveCheckoutEmail } from "@/lib/stripe";
import { assertCapability, getActiveProvider } from "@/lib/payments";
import { verifyPortalToken } from "@/lib/portalToken";
import {
  calculateOrderBalance,
  findActivePendingPayment,
  voidPendingPayment,
} from "@/lib/paymentService";
import { rateLimit } from "@/lib/rateLimit";

// 5 requests per minute per IP -- payment creation should be rare
const limiter = rateLimit({ windowMs: 60_000, maxRequests: 5 });

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { token, amount, force } = req.body as {
    token: string;
    amount?: number;
    /** Void an already-open PENDING checkout and replace it. See
     *  findActivePendingPayment — lets a customer retry when their earlier
     *  checkout attempt never went through. */
    force?: boolean;
  };

  if (!token) {
    return res.status(400).json({ error: "Token is required" });
  }

  const payload = verifyPortalToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired link" });
  }

  try {
    const order = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: payload.orderId },
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
        .json({ error: "This order has no customer on file; cannot start checkout." });
    }

    const balance = await calculateOrderBalance(payload.orderId);

    if (balance.balanceDue <= 0) {
      return res.status(400).json({ error: "No balance due on this order" });
    }

    // A PENDING row from a checkout this same customer may still be sitting
    // on (another tab, a back-button retry) — starting a second one risks
    // both landing (double-charge). The token already scopes this request
    // to their own order, so a self-service `force` retry is safe: it can
    // only ever void a PENDING payment on the order the customer's own link
    // points at.
    const existingPending = await findActivePendingPayment(payload.orderId);
    if (existingPending) {
      if (!force) {
        return res.status(409).json({
          error:
            `A payment of $${existingPending.amount.toFixed(2)} is already in progress on ` +
            `this order (started ${existingPending.ageMinutes} min ago). If that attempt ` +
            `failed, retry with force:true to start a new one.`,
          existingPayment: existingPending,
        });
      }
      await voidPendingPayment(existingPending.id, {
        voidedBy: "customer-portal",
        reason: "Replaced by a new checkout from the customer portal (force)",
      });
    }

    // Use requested amount if provided, otherwise full balance
    const paymentAmount = amount
      ? Math.min(Math.round(amount * 100) / 100, balance.balanceDue)
      : balance.balanceDue;

    if (paymentAmount <= 0) {
      return res.status(400).json({ error: "Payment amount must be greater than zero" });
    }

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

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
        requestedBy: "customer-portal",
      },
      successUrl: `${baseUrl}/portal/order?token=${token}&paid=true`,
      cancelUrl: `${baseUrl}/portal/order?token=${token}`,
    });

    // Create a PENDING payment record
    await prisma.payment.create({
      data: {
        salesOrderId: payload.orderId,
        paymentDate: new Date(),
        paymentType: isDeposit ? "Deposit" : "Card",
        paymentAmount: paymentAmount,
        status: "PENDING",
        method: "CARD",
        processorType: provider.id.toUpperCase(),
        processorTxnId: checkout.providerTxnId,
        createdBy: "customer-portal",
      },
    });

    return res.status(200).json({
      url: checkout.url,
      amount: paymentAmount,
      balanceDue: balance.balanceDue,
      isDeposit,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create payment";
    return res.status(500).json({ error: message });
  }
});
