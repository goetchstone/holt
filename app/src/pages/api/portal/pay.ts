// /app/src/pages/api/portal/pay.ts
//
// Portal-facing payment endpoint. Uses JWT token auth (no session required).
// Creates a Stripe checkout session for the specified amount.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getStripe, resolveCheckoutEmail } from "@/lib/stripe";
import { verifyPortalToken } from "@/lib/portalToken";
import { calculateOrderBalance } from "@/lib/paymentService";
import { rateLimit } from "@/lib/rateLimit";

// 5 requests per minute per IP -- payment creation should be rare
const limiter = rateLimit({ windowMs: 60_000, maxRequests: 5 });

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { token, amount } = req.body as { token: string; amount?: number };

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

    // Use requested amount if provided, otherwise full balance
    const paymentAmount = amount
      ? Math.min(Math.round(amount * 100) / 100, balance.balanceDue)
      : balance.balanceDue;

    if (paymentAmount <= 0) {
      return res.status(400).json({ error: "Payment amount must be greater than zero" });
    }

    const stripe = await getStripe();
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const amountInCents = Math.round(paymentAmount * 100);

    const isDeposit = paymentAmount < balance.balanceDue;
    const productName = isDeposit
      ? `Deposit - Order ${order.orderno}`
      : `Balance Due - Order ${order.orderno}`;

    const description = order.lineItems
      .slice(0, 5)
      .map((li) => li.productName || li.partNo || "Item")
      .join(", ");

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: productName,
              description: description || undefined,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      customer_email: resolveCheckoutEmail(order.customer.email),
      metadata: {
        orderId: order.id.toString(),
        orderno: order.orderno,
        storeLocation: order.storeLocation || "",
        isDeposit: isDeposit.toString(),
        requestedBy: "customer-portal",
      },
      success_url: `${baseUrl}/portal/order?token=${token}&paid=true`,
      cancel_url: `${baseUrl}/portal/order?token=${token}`,
    });

    // Create a PENDING payment record
    await prisma.payment.create({
      data: {
        salesOrderId: payload.orderId,
        paymentDate: new Date(),
        paymentType: isDeposit ? "Deposit - Stripe" : "Card - Stripe",
        paymentAmount: paymentAmount,
        status: "PENDING",
        method: "CARD",
        processorType: "STRIPE",
        processorTxnId: checkoutSession.id,
        createdBy: "customer-portal",
      },
    });

    return res.status(200).json({
      url: checkoutSession.url,
      amount: paymentAmount,
      balanceDue: balance.balanceDue,
      isDeposit,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create payment";
    return res.status(500).json({ error: message });
  }
});
