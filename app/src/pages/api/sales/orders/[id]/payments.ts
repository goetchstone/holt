// /app/src/pages/api/sales/orders/[id]/payments.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { recordPayment, calculateOrderBalance, onPaymentReceived } from "@/lib/paymentService";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return res.status(400).json({ error: "Invalid order ID" });

  if (req.method === "GET") {
    try {
      const balance = await calculateOrderBalance(orderId);
      return res.status(200).json(balance);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  }

  if (req.method === "POST") {
    try {
      const {
        method,
        amount,
        registerId,
        tillId,
        staffMemberId,
        customerId,
        processorType,
        processorTxnId,
        cardLast4,
        cardBrand,
        checkNumber,
        giftCardId,
      } = req.body;

      if (!method || !amount) {
        return res.status(400).json({ error: "method and amount are required" });
      }

      const payment = await recordPayment(orderId, {
        method,
        amount: Number.parseFloat(amount),
        registerId: registerId ? Number.parseInt(registerId) : undefined,
        tillId: tillId ? Number.parseInt(tillId) : undefined,
        staffMemberId: staffMemberId ? Number.parseInt(staffMemberId) : undefined,
        customerId: customerId ? Number.parseInt(customerId) : undefined,
        processorType,
        processorTxnId,
        cardLast4,
        cardBrand,
        checkNumber,
        giftCardId: giftCardId ? Number.parseInt(giftCardId) : undefined,
        createdBy: session.user?.email || undefined,
      });

      // Promote QUOTE → ORDER and create draft POs
      await onPaymentReceived(orderId);

      const balance = await calculateOrderBalance(orderId);

      return res.status(201).json({
        payment: {
          ...payment,
          paymentAmount: Number(payment.paymentAmount),
        },
        balance,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      logError("POST /sales/orders/[orderId]/payments error", err);
      return res.status(400).json({ error: msg });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
