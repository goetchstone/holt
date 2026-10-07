// /app/src/pages/api/warehouse/dispatch/pending.ts
//
// Returns sales orders where items are still arriving (partial customer stock).

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const orders = await prisma.salesOrder.findMany({
      where: {
        dispatchStatus: { in: ["PO_PLACED", "RECEIVED_IN_WAREHOUSE"] },
      },
      orderBy: { orderDate: "desc" },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
        lineItems: {
          select: {
            id: true,
            productName: true,
            orderedQuantity: true,
            purchaseOrderItems: {
              select: {
                receivingRecords: {
                  select: { quantityReceived: true },
                },
              },
            },
          },
        },
      },
      take: 100,
    });

    const pending = orders.map((order) => {
      const totalItems = order.lineItems.length;
      const receivedItems = order.lineItems.filter((li) => {
        const totalReceived = li.purchaseOrderItems.reduce(
          (sum, poi) =>
            sum + poi.receivingRecords.reduce((s, r) => s + Number(r.quantityReceived), 0),
          0,
        );
        return totalReceived >= Number(li.orderedQuantity);
      }).length;

      return {
        id: order.id,
        orderno: order.orderno,
        customerName: order.customer
          ? [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ") ||
            "Unknown"
          : "No Customer",
        orderDate: order.orderDate,
        dispatchStatus: order.dispatchStatus,
        deliveryMethod: order.deliveryMethod,
        scheduledDeliveryDate: order.scheduledDeliveryDate,
        totalItems,
        receivedItems,
        allReceived: receivedItems === totalItems && totalItems > 0,
      };
    });

    return res.status(200).json({ orders: pending });
  } catch (error) {
    logError("Error fetching pending dispatch", error);
    return res.status(500).json({ error: "Failed to fetch pending orders" });
  }
}

// The pending half of the dispatch queue's working list — same capability as
// the rest of dispatch (dispatch/unassigned.ts, dispatch/pick-lists, runs).
export default requirePermission("warehouse.operate", handler);
