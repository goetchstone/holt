// /app/src/pages/api/returns/[id]/refund.ts
//
// Pay out a return (lib/returns/refundReturn.ts): to a payment on the original
// order, the way it was taken, or to the customer's store credit, with the
// restocking fee on the first refund. Every rule is checked again here, not
// trusted from the screen: the return is not cancelled, the payment is the
// return's order's, and the amount is within what the return can still refund.
//
// Body: { destination, paymentId?, amount, restockingFee?: {percent}|{amount},
//         reason?, registerId?, tillId?, staffMemberId? }
//    or { retryRefundPaymentId } to finish a refund still waiting on its
//         processor, with the same idempotency key.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { RefundError, RefundProcessorError, retryProcessorRefund } from "@/lib/paymentService";
import { isRefundDestination, refundReturn } from "@/lib/returns/refundReturn";
import { ReturnMoneyError, type RestockingFeeInput } from "@/lib/returns/returnMoney";
import { StoreCreditError } from "@/lib/customerCredit";
import { logError } from "@/lib/logger";

const optionalInt = (v: unknown) => {
  const n = Number(v);
  return v == null || v === "" || !Number.isInteger(n) ? undefined : n;
};

/** {percent} or {amount}; undefined keeps what was booked; anything else is refused. */
function parseFee(raw: unknown): RestockingFeeInput | "invalid" {
  if (raw == null) return undefined;
  if (typeof raw !== "object") return "invalid";
  const r = raw as { percent?: unknown; amount?: unknown };
  if (r.percent != null && r.amount == null) {
    const p = Number(r.percent);
    return Number.isFinite(p) && p >= 0 && p <= 100 ? { percent: p } : "invalid";
  }
  if (r.amount != null && r.percent == null) {
    const a = Number(r.amount);
    return Number.isFinite(a) && a >= 0 ? { amount: a } : "invalid";
  }
  return "invalid";
}

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const returnId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(returnId)) return res.status(400).json({ error: "Invalid return ID" });
  const createdBy = session.user?.email || undefined;
  const body = (req.body ?? {}) as Record<string, unknown>;

  try {
    const ret = await prisma.return.findUnique({
      where: { id: returnId },
      select: { id: true, status: true, salesOrderId: true, lineItemId: true },
    });
    if (!ret) return res.status(404).json({ error: "Return not found" });
    if (ret.status === "CANCELLED") {
      return res.status(409).json({ error: "A cancelled return has no money to pay out." });
    }

    let refund;
    if (body.retryRefundPaymentId != null) {
      const retryId = optionalInt(body.retryRefundPaymentId);
      const row = retryId
        ? await prisma.payment.findUnique({ where: { id: retryId }, select: { returnId: true } })
        : null;
      if (!row || row.returnId !== returnId) {
        return res.status(400).json({ error: "That refund is not one of this return's." });
      }
      refund = await retryProcessorRefund(retryId!);
    } else {
      if (!isRefundDestination(body.destination)) {
        return res
          .status(400)
          .json({ error: "destination must be ORIGINAL_PAYMENT or STORE_CREDIT." });
      }
      // 0 books the return and pays only what the original order still owes.
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: "amount must be 0 or more." });
      }
      const fee = parseFee(body.restockingFee);
      if (fee === "invalid") {
        return res.status(400).json({
          error: "restockingFee must be {percent} between 0 and 100, or {amount} of 0 or more.",
        });
      }
      refund = await refundReturn(returnId, {
        destination: body.destination,
        paymentId: optionalInt(body.paymentId),
        amount,
        restockingFee: fee,
        reason: typeof body.reason === "string" && body.reason.trim() ? body.reason : undefined,
        registerId: optionalInt(body.registerId),
        tillId: optionalInt(body.tillId),
        staffMemberId: optionalInt(body.staffMemberId),
        createdBy,
      });
    }

    if (refund) {
      await prisma.orderChangeLog.create({
        data: {
          salesOrderId: ret.salesOrderId,
          lineItemId: ret.lineItemId,
          changeType: "RETURN_REFUND_ISSUED",
          newValue: `$${Number(refund.paymentAmount).toFixed(2)} ${refund.paymentType} (${refund.status})`,
          changedBy: createdBy ?? null,
        },
      });
    }

    return res.status(201).json({
      refund: refund
        ? { id: refund.id, amount: Number(refund.paymentAmount), status: refund.status }
        : null,
    });
  } catch (error: unknown) {
    if (error instanceof RefundProcessorError) {
      return res.status(502).json({ error: error.message });
    }
    if (
      error instanceof ReturnMoneyError ||
      error instanceof RefundError ||
      error instanceof StoreCreditError
    ) {
      return res.status(400).json({ error: error.message });
    }
    logError("Error processing return refund", error);
    return res.status(500).json({ error: "Failed to process the refund" });
  }
}

// Issuing a refund moves money. Register (till), Warehouse (returns desk),
// Manager, and Admin only.
export default requireAuthWithRole(
  ["SUPER_ADMIN", "MANAGER", "ADMIN", "REGISTER", "WAREHOUSE"],
  handler,
);
