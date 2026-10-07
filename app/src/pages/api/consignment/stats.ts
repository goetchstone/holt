// /app/src/pages/api/consignment/stats.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [statusCounts, totalCount, soldUnpaid] = await Promise.all([
      prisma.consignmentItem.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
      prisma.consignmentItem.count(),
      prisma.consignmentItem.count({
        where: { status: "SOLD", consignmentPaymentBatchId: null },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusCounts) {
      byStatus[row.status] = row._count.id;
    }

    // The Reconciliation page's four cards are counts. This route used to
    // answer with cost sums under other names (totalCostOnFloor,
    // totalCostSoldUnpaid), so the cards were blank and the store's cost went
    // to every caller.
    return res.json({
      onFloor: byStatus.ON_FLOOR ?? 0,
      onApproval: byStatus.ON_APPROVAL ?? 0,
      soldUnpaid,
      missing: byStatus.MISSING ?? 0,
      byStatus,
      totalItems: totalCount,
    });
  } catch (error) {
    logError("Error fetching consignment stats", error);
    return res.status(500).json({ error: "Failed to fetch consignment stats" });
  }
}

export default requirePermission("purchasing.receive", handler);
