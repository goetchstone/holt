// /app/src/pages/api/sales/orders/[id]/delivery-fee.ts
//
// GAP-09: the order screen's delivery fee.
//   GET -> { current, quote }: the fee the order charges now, and what its zone
//          would charge for its address and pieces (lib/delivery/deliveryFee.ts).
//   PUT { amount } -> charge, change, or (null or 0) remove the fee; answers
//          with the same shape as GET.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import { DeliveryFeeError, orderDeliveryFee, setDeliveryFee } from "@/lib/delivery/deliveryFee";

/** Exported for integration tests -- same pattern as create-from-cart.ts. */
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "GET" && req.method !== "PUT") {
    return methodNotAllowed(res, ["GET", "PUT"]);
  }
  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  try {
    if (req.method === "PUT") {
      const amount = (req.body ?? {}).amount;
      if (amount !== null && typeof amount !== "number") {
        return badRequest(res, "amount must be a number, or null to remove the fee.");
      }
      await prisma.$transaction((tx) =>
        setDeliveryFee(tx, { orderId, amount, actor: session.user?.email ?? null }),
      );
    }
    return res.status(200).json(await orderDeliveryFee(prisma, orderId));
  } catch (err) {
    if (err instanceof DeliveryFeeError) {
      return res.status(err.status).json({ error: err.message });
    }
    return handleError(res, err, "delivery fee");
  }
}

export default requirePermission("sales.write", handler);
