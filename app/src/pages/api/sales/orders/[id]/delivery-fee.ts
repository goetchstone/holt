// /app/src/pages/api/sales/orders/[id]/delivery-fee.ts
//
// GAP-09: the order screen's delivery fee.
//   GET -> { current, quote }: the fee the order charges now, and what its zone
//          would charge for its address and pieces (lib/delivery/deliveryFee.ts).
//   PUT { amount, discountApproval? } -> charge, change, or (null or 0) remove
//          the fee; answers with the same shape as GET. On a delivery order, a
//          fee below the zone's is a discount and follows the store's policy
//          (lib/sales/discountApproval.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import {
  DeliveryFeeError,
  feeIsEditable,
  orderDeliveryFee,
  setDeliveryFee,
} from "@/lib/delivery/deliveryFee";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import {
  DiscountApprovalError,
  NO_EXTRA_ACCESS,
  authorizeDiscount,
  logDiscountApproval,
} from "@/lib/sales/discountApproval";
import { lineDiscountPercent } from "@/lib/sales/discountPolicyShared";
import { deliveryFeeProblem } from "@/lib/delivery/deliveryFeeShared";

/** Exported for integration tests -- same pattern as create-from-cart.ts. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess = NO_EXTRA_ACCESS,
) {
  if (req.method !== "GET" && req.method !== "PUT") {
    return methodNotAllowed(res, ["GET", "PUT"]);
  }
  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  try {
    if (req.method === "PUT") {
      const refused = await putFee(req, session, access, orderId);
      if (refused) return badRequest(res, refused);
    }
    return res.status(200).json(await orderDeliveryFee(prisma, orderId));
  } catch (err) {
    if (err instanceof DeliveryFeeError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof DiscountApprovalError) {
      return res.status(err.status).json(err.body);
    }
    return handleError(res, err, "delivery fee");
  }
}

export default requirePermission("sales.write", handler, { also: ["sales.discount"] });

/**
 * Charge, change or remove the fee, approved when it is a discount. Returns why
 * the body can't be a fee, or null when it was written.
 */
async function putFee(
  req: NextApiRequest,
  session: Session,
  access: CallerAccess,
  orderId: number,
): Promise<string | null> {
  const amount = (req.body ?? {}).amount;
  if (amount !== null && typeof amount !== "number") {
    return "amount must be a number, or null to remove the fee.";
  }
  const problem = amount === null ? null : deliveryFeeProblem(amount);
  if (problem) return problem;
  const actor = session.user?.email ?? null;
  const percent = await feeDiscountPercent(orderId, amount ?? 0);
  const approver = await authorizeDiscount(prisma, {
    percent,
    access,
    approval: (req.body ?? {}).discountApproval,
  });
  await prisma.$transaction(async (tx) => {
    const result = await setDeliveryFee(tx, { orderId, amount, actor });
    if (approver) {
      await logDiscountApproval(tx, {
        orderId,
        lineItemId: result.lineItemId,
        approver,
        percent,
        changedBy: actor,
      });
    }
  });
  return null;
}

/**
 * How far below its zone's fee a delivery order's fee would be, percent. An
 * order whose fee can't change at all asks nobody: setDeliveryFee refuses it.
 */
async function feeDiscountPercent(orderId: number, amount: number): Promise<number> {
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    select: { deliveryMethod: true, status: true },
  });
  if (!order || !feeIsEditable(order.status) || order.deliveryMethod !== "DELIVERY") return 0;
  const { quote } = await orderDeliveryFee(prisma, orderId);
  return lineDiscountPercent({ listUnit: quote.amount, quantity: 1, netPrice: amount });
}
