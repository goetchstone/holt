// /app/src/pages/api/sales/orders/[id]/card-reader-payment.ts
//
// Send a card payment for this order to the reader at the cashier's register.
// The answer comes back at once, WAITING: the customer has yet to present a
// card. The register then asks payments/[paymentId]/card-reader how it went.
// payment.take, as recording any other tender is (./payments.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { badRequest, created, handleError, methodNotAllowed } from "@/lib/apiResponse";
import { startReaderPayment } from "@/lib/payments/cardReaderPayments";

function optionalId(value: unknown): number | undefined {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const orderId = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");
  const { amount, registerId, tillId, staffMemberId } = (req.body ?? {}) as Record<string, unknown>;
  const register = optionalId(registerId);
  if (!register) return badRequest(res, "Choose the register this payment is taken at.");

  try {
    const started = await startReaderPayment(orderId, {
      amount: Number(amount),
      registerId: register,
      tillId: optionalId(tillId),
      staffMemberId: optionalId(staffMemberId),
      actor: session.user?.email ?? null,
    });
    return created(res, started);
  } catch (err) {
    return handleError(res, err, `POST /sales/orders/${orderId}/card-reader-payment`);
  }
}

export default requirePermission("payment.take", handler);
