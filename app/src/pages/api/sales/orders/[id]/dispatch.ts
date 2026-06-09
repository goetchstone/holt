// /app/src/pages/api/sales/orders/[id]/dispatch.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  success,
  unauthorized,
  badRequest,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

const VALID_STATUSES = [
  "PO_PLACED",
  "RECEIVED_IN_WAREHOUSE",
  "READY_FOR_PICKUP",
  "SCHEDULED_DELIVERY",
  "FULFILLED",
  "CANCELLED",
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return unauthorized(res);

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

  try {
    const order = await prisma.salesOrder.update({
      where: { id: orderId },
      data: {
        ...(dispatchStatus !== undefined && { dispatchStatus }),
        ...(deliveryMethod !== undefined && { deliveryMethod: deliveryMethod || null }),
        ...(deliveryAddressId !== undefined && { deliveryAddressId: deliveryAddressId || null }),
        ...(pickupLocationId !== undefined && { pickupLocationId: pickupLocationId || null }),
        ...(scheduledDeliveryDate !== undefined && {
          scheduledDeliveryDate: scheduledDeliveryDate ? new Date(scheduledDeliveryDate) : null,
        }),
        ...(deliveryNotes !== undefined && { deliveryNotes: deliveryNotes || null }),
        updatedBy: session.user.email,
      },
    });

    return success(res, order);
  } catch (err) {
    return handleError(res, err, "PUT /sales/orders/[id]/dispatch");
  }
}
