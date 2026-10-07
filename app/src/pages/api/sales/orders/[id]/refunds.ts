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
import { processRefund, calculateOrderBalance } from "@/lib/paymentService";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  try {
    const { paymentId, amount, method, reason, registerId, tillId, staffMemberId, customerId } =
      req.body;

    if (!paymentId || !amount) return badRequest(res, "paymentId and amount are required");

    const refund = await processRefund(Number.parseInt(paymentId), {
      amount: Number.parseFloat(amount),
      method: method || undefined,
      reason: reason || undefined,
      registerId: registerId ? Number.parseInt(registerId) : undefined,
      tillId: tillId ? Number.parseInt(tillId) : undefined,
      staffMemberId: staffMemberId ? Number.parseInt(staffMemberId) : undefined,
      customerId: customerId ? Number.parseInt(customerId) : undefined,
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
    return handleError(res, err, "POST /sales/orders/[id]/refunds");
  }
}

export default requirePermission("payment.refund", handler);
