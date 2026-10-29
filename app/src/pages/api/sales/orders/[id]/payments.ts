// /app/src/pages/api/sales/orders/[id]/payments.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { recordPayment, calculateOrderBalance, onPaymentReceived } from "@/lib/paymentService";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
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
      // No processorType/processorTxnId from the browser: a refund is routed
      // to the processor those name (paymentService.processRefund), so a
      // payment posted here with another customer's charge id could be
      // refunded onto that customer's card. Processor payments are written
      // by the hosted-checkout flow (recordPendingPayment), never this route.
      const {
        method,
        amount,
        registerId,
        tillId,
        staffMemberId,
        customerId,
        cardLast4,
        cardBrand,
        checkNumber,
        giftCardId,
        tenderId,
        reference,
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
        cardLast4,
        cardBrand,
        checkNumber,
        giftCardId: giftCardId ? Number.parseInt(giftCardId) : undefined,
        tenderId: tenderId ? Number.parseInt(tenderId) : undefined,
        reference: typeof reference === "string" ? reference : undefined,
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

// Taking money is payment.take, held by the Register as well as managers: the
// register's checkout posts its tenders here, and the MANAGER/ADMIN role list
// this replaced refused it.
export default requirePermission("payment.take", handler);
