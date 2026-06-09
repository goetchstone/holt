// /app/src/pages/api/consignment/count-summary.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuth } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuth(async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [onFloor, onApproval, total] = await Promise.all([
      prisma.consignmentItem.count({ where: { status: "ON_FLOOR" } }),
      prisma.consignmentItem.count({ where: { status: "ON_APPROVAL" } }),
      prisma.consignmentItem.count({
        where: { status: { in: ["ON_FLOOR", "ON_APPROVAL"] } },
      }),
    ]);

    return res.json({ onFloor, onApproval, expectedOnHand: total });
  } catch (error) {
    logError("Error fetching consignment count summary", error);
    return res.status(500).json({ error: "Failed to fetch count summary" });
  }
});
