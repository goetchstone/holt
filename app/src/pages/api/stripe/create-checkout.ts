// /app/src/pages/api/stripe/create-checkout.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import { calculateOrderBalance, recordPendingPayment } from "@/lib/paymentService";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { orderId, successUrl, cancelUrl } = req.body as {
    orderId: number;
    successUrl?: string;
    cancelUrl?: string;
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
    const stripe = await getStripe();
    const amountInCents = Math.round(balance.balanceDue * 100);

    const description = `Order ${order.orderno}`;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: description },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      customer_email: order.customer?.email || undefined,
      metadata: {
        orderId: order.id.toString(),
        orderno: order.orderno,
      },
      success_url: successUrl || `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${baseUrl}/app/payment/cancel?order_id=${orderId}`,
    });

    // PENDING + no ledger entry yet. The AR-ledger entry is posted only when the
    // webhook confirms the charge (completePayment), so an abandoned checkout
    // leaves nothing in the books. (#137)
    await recordPendingPayment(orderId, {
      method: "CARD",
      amount: balance.balanceDue,
      processorType: "STRIPE",
      processorTxnId: checkoutSession.id,
      createdBy: session.user?.email || undefined,
    });

    return res.status(200).json({
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create checkout session";
    return res.status(500).json({ error: message });
  }
}
