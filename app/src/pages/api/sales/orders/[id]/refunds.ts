// /app/src/pages/api/sales/orders/[id]/refunds.ts
//
// FIRST route on the permission guard. Chosen because it is the one the audit
// in PR #67 found with no authorization at all: it took a session and refunded
// a card, so any signed-in account -- including one that was never staff --
// could return money. #67 gave it a MANAGER/ADMIN role gate as the stopgap;
// this is the capability it was always really asking for.
//
// The set of people who can call it is unchanged: MANAGER and ADMIN both hold
// payment.refund in BUILT_IN_ROLES, and SUPER_ADMIN holds it through the
// wildcard exactly as it previously satisfied the ADMIN gate. What changes is
// that a deployment can now move that capability without editing this file.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import {
  processRefund,
  calculateOrderBalance,
  RefundError,
  RefundProcessorError,
} from "@/lib/paymentService";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  try {
    // A refund goes back the way the payment was taken; there is no `method`
    // to send it some other way (a card refunded "to store credit" refunded
    // the card and issued credit too). Store credit for a return is
    // /api/returns/[id]/refund.
    const { paymentId, amount, reason, registerId, tillId, staffMemberId } = req.body;

    if (!paymentId || !amount) return badRequest(res, "paymentId and amount are required");

    const payment = await prisma.payment.findUnique({
      where: { id: Number.parseInt(paymentId) },
      select: { salesOrderId: true },
    });
    if (!payment || payment.salesOrderId !== orderId) {
      return badRequest(res, "That payment is not a payment on this order.");
    }

    const refund = await processRefund(Number.parseInt(paymentId), {
      amount: Number.parseFloat(amount),
      reason: reason || undefined,
      registerId: registerId ? Number.parseInt(registerId) : undefined,
      tillId: tillId ? Number.parseInt(tillId) : undefined,
      staffMemberId: staffMemberId ? Number.parseInt(staffMemberId) : undefined,
      createdBy: session.user?.email || undefined,
    });

    const balance = await calculateOrderBalance(orderId);

    return res.status(201).json({
      refund: {
        ...refund,
        paymentAmount: Number(refund.paymentAmount),
      },
      balance,
    });
  } catch (err) {
    if (err instanceof RefundProcessorError) return res.status(502).json({ error: err.message });
    if (err instanceof RefundError) return badRequest(res, err.message);
    return handleError(res, err, "POST /sales/orders/[id]/refunds");
  }
}

export default requirePermission("payment.refund", handler);
