// /app/src/pages/api/consignment/bulk-reset-missing.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      const result = await prisma.consignmentItem.updateMany({
        where: { status: "MISSING" },
        data: { status: "ON_FLOOR", updatedBy: session.user?.email ?? "admin" },
      });

      return res.json({ updated: result.count });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  },
);
