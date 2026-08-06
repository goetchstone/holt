// /app/src/pages/api/sales/orders/[id]/dispatch.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { success, badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import { consume, release } from "@/lib/inventory/allocation";
import { getActiveOrderLines } from "@/lib/inventory/orderInventorySync";

const VALID_STATUSES = [
  "PO_PLACED",
  "RECEIVED_IN_WAREHOUSE",
  "READY_FOR_PICKUP",
  "SCHEDULED_DELIVERY",
  "FULFILLED",
  "CANCELLED",
];

/** Exported for integration tests -- same pattern as create-from-cart.ts:
 *  calls the real Prisma client with a fake req/res + session, bypassing
 *  requireAuthWithRole (which needs real cookies). Role enforcement is
 *  covered by the apiRouteAuthorization tripwire. */
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") return methodNotAllowed(res, ["PUT"]);

  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  const {
    dispatchStatus,
    deliveryMethod,
    deliveryAddressId,
    pickupLocationId,
    scheduledDeliveryDate,
    deliveryNotes,
  } = req.body;

  if (dispatchStatus && !VALID_STATUSES.includes(dispatchStatus)) {
    return badRequest(res, `Invalid dispatch status: ${dispatchStatus}`);
  }

  const updateData = {
    ...(dispatchStatus !== undefined && { dispatchStatus }),
    ...(deliveryMethod !== undefined && { deliveryMethod: deliveryMethod || null }),
    ...(deliveryAddressId !== undefined && { deliveryAddressId: deliveryAddressId || null }),
    ...(pickupLocationId !== undefined && { pickupLocationId: pickupLocationId || null }),
    ...(scheduledDeliveryDate !== undefined && {
      scheduledDeliveryDate: scheduledDeliveryDate ? new Date(scheduledDeliveryDate) : null,
    }),
    ...(deliveryNotes !== undefined && { deliveryNotes: deliveryNotes || null }),
    updatedBy: session.user.email,
  };

  // FULFILLED/CANCELLED are the only dispatchStatus values that need to move
  // inventory (the goods left the building, or the dispatch is off) -- only
  // that path pays for a transaction. Every other write stays a plain update.
  const isTerminalTransition = dispatchStatus === "FULFILLED" || dispatchStatus === "CANCELLED";

  try {
    if (!isTerminalTransition) {
      const order = await prisma.salesOrder.update({ where: { id: orderId }, data: updateData });
      return success(res, order);
    }

    const order = await prisma.$transaction(async (tx) => {
      const existing = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: { dispatchStatus: true },
      });

      const updated = await tx.salesOrder.update({ where: { id: orderId }, data: updateData });

      // Consume/release on the TRANSITION into the terminal state, not on
      // every write -- guarded by comparing against the pre-update value.
      // Both are no-ops if nothing is currently committed, which is correct
      // (e.g. this order's stock was already consumed via SalesOrder.status
      // -- see allocation.ts's consume()/release() headers).
      if (dispatchStatus === "FULFILLED" && existing?.dispatchStatus !== "FULFILLED") {
        const lines = await getActiveOrderLines(orderId, tx);
        await consume(orderId, lines, tx);
      } else if (dispatchStatus === "CANCELLED" && existing?.dispatchStatus !== "CANCELLED") {
        await release(orderId, tx);
      }

      return updated;
    });

    return success(res, order);
  } catch (err) {
    return handleError(res, err, "PUT /sales/orders/[id]/dispatch");
  }
}

export default requireAuthWithRole(["DESIGNER", "REGISTER", "MANAGER", "ADMIN"], handler);
