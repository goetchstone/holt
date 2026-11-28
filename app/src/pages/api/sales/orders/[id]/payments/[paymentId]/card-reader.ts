// /app/src/pages/api/sales/orders/[id]/payments/[paymentId]/card-reader.ts
//
// A card payment out on a reader: how it went (GET, which also records the
// outcome), stop it (DELETE), and in test mode present a test card to a
// simulated reader (POST). All payment.take: it is the cashier's own payment.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, handleError, methodNotAllowed, notFound, success } from "@/lib/apiResponse";
import { calculateOrderBalance } from "@/lib/paymentService";
import {
  cancelReaderPayment,
  presentTestCard,
  settleReaderPayment,
} from "@/lib/payments/cardReaderPayments";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const orderId = Number.parseInt(req.query.id as string, 10);
  const paymentId = Number.parseInt(req.query.paymentId as string, 10);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");
  if (Number.isNaN(paymentId)) return badRequest(res, "Invalid payment ID");
  if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "POST") {
    return methodNotAllowed(res, ["GET", "DELETE", "POST"]);
  }

  try {
    // The payment must be this order's before anything is asked of the reader.
    const existing = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { salesOrderId: true },
    });
    if (!existing || existing.salesOrderId !== orderId) return notFound(res, "Payment");

    if (req.method === "POST") {
      // Anything but an asked-for decline presents the card that is approved.
      const decline = (req.body as { outcome?: unknown } | undefined)?.outcome === "decline";
      await presentTestCard(paymentId, decline ? "decline" : "approve");
      return success(res, { presented: true });
    }
    const state =
      req.method === "DELETE"
        ? await cancelReaderPayment(paymentId, session.user?.email ?? null)
        : await settleReaderPayment(paymentId);
    // The register shows what is still owed as soon as the card goes through.
    const balance = state.status === "APPROVED" ? await calculateOrderBalance(orderId) : undefined;
    return success(res, { ...state, balance });
  } catch (err) {
    return handleError(
      res,
      err,
      `${req.method} /sales/orders/${orderId}/payments/${paymentId}/card-reader`,
    );
  }
}

export default requirePermission("payment.take", handler);
