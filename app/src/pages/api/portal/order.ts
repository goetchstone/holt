// /app/src/pages/api/portal/order.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { verifyPortalToken } from "@/lib/portalToken";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";
import { computeBalance } from "@/lib/paymentService";
import { isCountedLine } from "@/lib/salesOrderRevenue";
import { isPaymentExcludedFromBalance, signedPaymentAmount } from "@/lib/paymentBalance";

// 20 requests per minute per IP -- generous for legitimate use, stops enumeration
const limiter = rateLimit({ windowMs: 60_000, maxRequests: 20 });

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { token } = req.query;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Token is required" });
  }

  const payload = verifyPortalToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: payload.orderId },
      include: {
        customer: true,
        lineItems: true,
        payments: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.customerId !== payload.customerId) {
      return res.status(403).json({ error: "Token does not match this order" });
    }

    // The customer sees what the register charges: only lines still owed, and only payments
    // that settled, a refund taking money back. Summing every row showed cancelled and
    // replaced lines, and counted pending, voided and refunded money as paid.
    const { totalDue: totalAmount, totalPaid, balanceDue } = computeBalance(
      order.lineItems,
      order.payments,
    );

    return res.status(200).json({
      id: order.id,
      orderno: order.orderno,
      orderDate: order.orderDate,
      status: order.status,
      customer: order.customer
        ? {
            firstName: order.customer.firstName,
            lastName: order.customer.lastName,
          }
        : null,
      lineItems: order.lineItems
        .filter((item) => isCountedLine(item.lineItemStatus))
        .map((item) => ({
        id: item.id,
        productName: item.productName,
        orderedQuantity: Number(item.orderedQuantity),
        netPrice: Number(item.netPrice),
        vatAmount: item.vatAmount != null ? Number(item.vatAmount) : null,
      })),
      payments: order.payments
        .filter((p) => !isPaymentExcludedFromBalance(p.status))
        .map((p) => ({
          id: p.id,
          paymentDate: p.paymentDate,
          paymentType: p.paymentType,
          paymentAmount: signedPaymentAmount({
            paymentAmount: Number(p.paymentAmount),
            isRefund: p.isRefund,
          }),
        })),
      totalAmount,
      totalPaid,
      balanceDue,
    });
  } catch (error) {
    logError("Portal order fetch error", error);
    return res.status(500).json({ error: "Failed to fetch order" });
  }
});
