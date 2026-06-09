// /app/src/pages/api/purchasing/needs-ordering.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const orders = await prisma.salesOrder.findMany({
      where: {
        status: "ORDER",
        purchaseOrders: { none: {} },
        // At least one active line item that has no porNumber and no linked PO item
        lineItems: {
          some: {
            lineItemStatus: "ACTIVE",
            porNumber: null,
            purchaseOrderItems: { none: {} },
          },
        },
      },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
        lineItems: {
          select: {
            id: true,
            netPrice: true,
            orderedQuantity: true,
            vatAmount: true,
            porNumber: true,
            lineItemStatus: true,
            purchaseOrderItems: { select: { id: true } },
          },
        },
      },
      orderBy: { orderDate: "desc" },
    });

    const result = orders.map((order) => {
      // Only count line items that still need ordering
      const unorderedLines = order.lineItems.filter(
        (li) =>
          li.lineItemStatus === "ACTIVE" && !li.porNumber && li.purchaseOrderItems.length === 0,
      );
      const total = unorderedLines.reduce((sum, li) => {
        // netPrice is the LINE TOTAL; do not multiply by orderedQuantity
        const lineTotal = Number(li.netPrice);
        const vat = Number(li.vatAmount ?? 0);
        return sum + lineTotal + vat;
      }, 0);

      return {
        id: order.id,
        orderno: order.orderno,
        orderDate: order.orderDate,
        customerName: order.customer
          ? `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim()
          : null,
        itemCount: unorderedLines.length,
        total: Math.round(total * 100) / 100,
      };
    });

    return res.status(200).json({ orders: result });
  } catch (error) {
    logError("Error fetching needs-ordering", error);
    return res.status(500).json({ error: "Failed to fetch orders needing POs." });
  }
}
