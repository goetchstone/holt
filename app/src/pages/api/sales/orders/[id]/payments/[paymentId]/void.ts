// /app/src/pages/api/sales/orders/[id]/payments/[paymentId]/void.ts
//
// Manual escape hatch for a stuck PENDING payment (abandoned/declined
// hosted checkout that the webhook's checkout.session.expired handling and
// the expire-stale-pending-payments sweeper haven't caught yet, or an
// operator who doesn't want to wait). Before this route existed, clearing a
// PENDING row needed direct SQL — nothing in the product could touch it.
//
// MANAGER/ADMIN-gated: voiding a payment row is money-adjacent even though
// PENDING rows never posted to the AR ledger (recordPendingPayment defers
// that to completePayment) — a mistaken void here is what lets a genuinely
// in-flight checkout get replaced out from under a customer who's mid-pay.
// requireAuthWithRole below is also what satisfies
// __tests__/apiRouteAuthorization.test.ts's "every mutating route makes an
// explicit role decision" tripwire.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { voidPendingPayment, calculateOrderBalance } from "@/lib/paymentService";
import { badRequest, methodNotAllowed, notFound, handleError } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const orderId = Number.parseInt(req.query.id as string, 10);
  const paymentId = Number.parseInt(req.query.paymentId as string, 10);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");
  if (Number.isNaN(paymentId)) return badRequest(res, "Invalid payment ID");

  const { reason } = (req.body ?? {}) as { reason?: string };

  try {
    // Confirm the payment actually belongs to the order in the URL BEFORE
    // touching it — otherwise a guessed/wrong orderId with a valid
    // paymentId could void a payment on someone else's order and only
    // notice after the fact.
    const existing = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { salesOrderId: true },
    });
    if (!existing || existing.salesOrderId !== orderId) {
      return notFound(res, "Payment");
    }

    const voided = await voidPendingPayment(paymentId, {
      voidedBy: session.user?.email,
      reason: reason || undefined,
    });

    const balance = await calculateOrderBalance(orderId);

    return res.status(200).json({
      payment: { ...voided, paymentAmount: Number(voided.paymentAmount) },
      balance,
    });
  } catch (err) {
    return handleError(res, err, "POST /sales/orders/[id]/payments/[paymentId]/void");
  }
}

export default requirePermission("payment.void", handler);
