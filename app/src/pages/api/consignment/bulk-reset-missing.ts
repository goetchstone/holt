// /app/src/pages/api/consignment/bulk-reset-missing.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requirePermission(
  "admin.data",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      const result = await prisma.consignmentItem.updateMany({
        where: { status: "MISSING" },
        data: { status: "ON_FLOOR", updatedBy: session.user?.email ?? "admin" },
      });

      await auditLog("CONSIGNMENT_RESET", auditActor(session), {
        summary: `${result.count} missing consignment items put back on the floor`,
        details: { updated: result.count },
      });
      return res.json({ updated: result.count });
    } catch (err: unknown) {
      logError("Consignment bulk reset of missing items failed", err);
      return res.status(500).json({ error: "Couldn't put the missing items back on the floor." });
    }
  },
);
