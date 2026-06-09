// /app/src/pages/api/consignment/stats.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [statusCounts, totalCount, onFloorValue, soldUnpaidValue] = await Promise.all([
      prisma.consignmentItem.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
      prisma.consignmentItem.count(),
      prisma.consignmentItem.aggregate({
        where: { status: "ON_FLOOR" },
        _sum: { cost: true },
      }),
      prisma.consignmentItem.aggregate({
        where: { status: "SOLD", consignmentPaymentBatchId: null },
        _sum: { cost: true },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusCounts) {
      byStatus[row.status] = row._count.id;
    }

    return res.json({
      byStatus,
      totalItems: totalCount,
      totalCostOnFloor: Number(onFloorValue._sum.cost ?? 0),
      totalCostSoldUnpaid: Number(soldUnpaidValue._sum.cost ?? 0),
    });
  } catch (error) {
    logError("Error fetching consignment stats", error);
    return res.status(500).json({ error: "Failed to fetch consignment stats" });
  }
}
