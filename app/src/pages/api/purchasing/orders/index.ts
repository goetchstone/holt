// /app/src/pages/api/purchasing/orders/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
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
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string)?.trim() || "";

    const skip = (page - 1) * limit;

    const isReturnFilter = req.query.isReturn as string | undefined;

    const where: Prisma.PurchaseOrderWhereInput = {
      ...(isReturnFilter === "true" ? { isReturn: true } : {}),
      ...(isReturnFilter === "false" ? { isReturn: false } : {}),
      ...(search
        ? {
            OR: [
              { poNumber: { contains: search, mode: "insensitive" } },
              { vendor: { name: { contains: search, mode: "insensitive" } } },
              { notes: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { orderDate: "desc" },
        include: {
          vendor: { select: { id: true, name: true } },
          lineItems: {
            select: {
              orderedQuantity: true,
              unitCost: true,
              _count: { select: { receivingRecords: true } },
            },
          },
        },
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    const safeOrders = orders.map((po) => {
      const lineItemCount = po.lineItems.length;
      const totalCost = po.lineItems.reduce(
        (sum, item) => sum + Number(item.orderedQuantity) * Number(item.unitCost),
        0,
      );
      const receivedItemCount = po.lineItems.filter(
        (item) => item._count.receivingRecords > 0,
      ).length;

      return {
        id: po.id,
        poNumber: po.poNumber,
        vendorName: po.vendor.name,
        orderDate: po.orderDate,
        expectedDelivery: po.expectedDelivery,
        status: po.status,
        isReturn: po.isReturn,
        lineItemCount,
        totalCost,
        receivedItemCount,
      };
    });

    return res.status(200).json({ orders: safeOrders, total });
  } catch (error) {
    logError("Error fetching purchase orders", error);
    return res.status(500).json({ error: "Failed to fetch purchase orders" });
  }
}
