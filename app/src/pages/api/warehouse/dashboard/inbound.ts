// /app/src/pages/api/warehouse/dashboard/inbound.ts

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
    const pendingPOs = await prisma.purchaseOrder.findMany({
      where: {
        status: { in: ["SUBMITTED", "CONFIRMED"] },
      },
      orderBy: { expectedDelivery: "asc" },
      include: {
        vendor: { select: { name: true } },
        lineItems: {
          select: {
            id: true,
            partNo: true,
            productName: true,
            orderedQuantity: true,
            receivingRecords: {
              select: { quantityReceived: true },
            },
          },
        },
      },
      take: 50,
    });

    const inbound = pendingPOs.map((po) => {
      const items = po.lineItems.map((item) => {
        const received = item.receivingRecords.reduce(
          (sum, r) => sum + Number(r.quantityReceived),
          0,
        );
        return {
          id: item.id,
          partNo: item.partNo,
          productName: item.productName,
          ordered: Number(item.orderedQuantity),
          received,
          remaining: Number(item.orderedQuantity) - received,
        };
      });

      return {
        id: po.id,
        poNumber: po.poNumber,
        vendorName: po.vendor.name,
        status: po.status,
        expectedDelivery: po.expectedDelivery,
        itemCount: items.length,
        pendingItems: items.filter((i) => i.remaining > 0).length,
      };
    });

    return res.status(200).json({ inbound });
  } catch (error) {
    logError("Error fetching inbound items", error);
    return res.status(500).json({ error: "Failed to fetch inbound items" });
  }
}
