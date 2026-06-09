// /app/src/pages/api/warehouse/dispatch/ready.ts
//
// Returns sales orders where all items are received and ready for dispatch.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { success, unauthorized, methodNotAllowed, handleError } from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const orders = await prisma.salesOrder.findMany({
      where: {
        dispatchStatus: { in: ["RECEIVED_IN_WAREHOUSE", "READY_FOR_PICKUP", "SCHEDULED_DELIVERY"] },
      },
      orderBy: [{ scheduledDeliveryDate: "asc" }, { orderDate: "desc" }],
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            addresses: { take: 1, select: { city: true, state: true, zip: true } },
          },
        },
        lineItems: {
          select: { id: true, orderedQuantity: true },
        },
      },
      take: 100,
    });

    const ready = orders.map((order) => ({
      id: order.id,
      orderno: order.orderno,
      customerName: order.customer
        ? [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ") || "Unknown"
        : "No Customer",
      customerZip: order.customer?.addresses?.[0]?.zip || null,
      orderDate: order.orderDate,
      dispatchStatus: order.dispatchStatus,
      deliveryMethod: order.deliveryMethod,
      scheduledDeliveryDate: order.scheduledDeliveryDate,
      deliveryNotes: order.deliveryNotes,
      itemCount: order.lineItems.length,
    }));

    return success(res, { orders: ready });
  } catch (err) {
    return handleError(res, err, "GET /warehouse/dispatch/ready");
  }
}
