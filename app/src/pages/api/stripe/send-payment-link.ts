// /app/src/pages/api/stripe/send-payment-link.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { getStripe, resolveCheckoutEmail } from "@/lib/stripe";
import { calculateOrderBalance } from "@/lib/paymentService";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { orderId, amount: requestedAmount } = req.body as {
    orderId: number;
    amount?: number;
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

    const stripe = await getStripe();
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const amountInCents = Math.round(paymentAmount * 100);

    // Build line item description for the checkout page
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
        requestedBy: session.user?.email || "",
      },
      success_url: `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/app/payment/cancel?order_id=${orderId}`,
    });

    // Create a PENDING payment record for tracking
    await prisma.payment.create({
      data: {
        salesOrderId: orderId,
        paymentDate: new Date(),
        paymentType: isDeposit ? "Deposit - Stripe" : "Card - Stripe",
        paymentAmount: paymentAmount,
        status: "PENDING",
        method: "CARD",
        processorType: "STRIPE",
        processorTxnId: checkoutSession.id,
        createdBy: session.user?.email || undefined,
      },
    });

    return res.status(200).json({
      url: checkoutSession.url,
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
