// /app/src/pages/api/inventory/clear-all-data.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Use a transaction to ensure all or no data is deleted.
    const [reconciliations, unidentifiedScans, physicalCounts] = await prisma.$transaction([
      prisma.reconciliation.deleteMany({}),
      prisma.unidentifiedScan.deleteMany({}),
      prisma.physicalInventoryCount.deleteMany({}),
    ]);

    res.status(200).json({
      message: "All physical inventory data has been cleared.",
      deletedCounts: {
        reconciliations: reconciliations.count,
        unidentifiedScans: unidentifiedScans.count,
        physicalCounts: physicalCounts.count,
      },
    });
  } catch (error) {
    logError("Failed to clear all inventory data", error);
    res.status(500).json({ error: "An error occurred while clearing inventory data." });
  }
});
