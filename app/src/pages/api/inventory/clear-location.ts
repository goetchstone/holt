// /app/src/pages/api/inventory/clear-location.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { location } = req.body;
  if (!location) {
    return res.status(400).json({ error: "Location is required." });
  }

  try {
    // Use a transaction to ensure both deletions succeed or fail together.
    const [physicalCounts, reconciliations] = await prisma.$transaction([
      prisma.physicalInventoryCount.deleteMany({
        where: { stockLocation: location },
      }),
      prisma.reconciliation.deleteMany({
        where: { location: location },
      }),
    ]);

    res.status(200).json({
      message: `Successfully deleted ${physicalCounts.count} scans and ${reconciliations.count} reconciliations from ${location}.`,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to clear scans for location." });
  }
});
