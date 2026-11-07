// /app/src/pages/api/inventory/physical-count/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { id } = req.query;

  if (req.method === "DELETE") {
    try {
      const scan = await prisma.physicalInventoryCount.delete({
        where: { id: Number(id) },
      });
      await auditLog("PHYSICAL_COUNT_DELETED", auditActor(session), {
        summary: `A scan at ${scan.stockLocation} deleted`,
        details: { scanId: scan.id, stockLocation: scan.stockLocation },
      });
      res.status(204).end(); // Success, no content to return
    } catch (error) {
      logError("Failed to delete scan", error);
      res.status(500).json({ error: "Failed to delete scan." });
    }
  } else {
    res.setHeader("Allow", ["DELETE"]);
    res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
}

export default requirePermission("inventory.count", handler);
