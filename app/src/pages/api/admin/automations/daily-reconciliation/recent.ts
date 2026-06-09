// /app/src/pages/api/admin/automations/daily-reconciliation/recent.ts
//
// Returns the last 30 days of DailyReconciliationLog rows for the admin
// page. Read-only. MANAGER/ADMIN gated.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/money";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 30);

    const rows = await prisma.dailyReconciliationLog.findMany({
      where: { created: { gte: cutoff } },
      orderBy: { created: "desc" },
      take: 100,
      select: {
        id: true,
        date: true,
        balanced: true,
        driftRevenue: true,
        driftTax: true,
        driftCost: true,
        driftCash: true,
        warnings: true,
        journalEntryId: true,
        created: true,
      },
    });

    return res.status(200).json({
      logs: rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString(),
        balanced: r.balanced,
        driftRevenue: toNumber(r.driftRevenue),
        driftTax: toNumber(r.driftTax),
        driftCost: toNumber(r.driftCost),
        driftCash: toNumber(r.driftCash),
        warnings: r.warnings,
        journalEntryId: r.journalEntryId,
        created: r.created.toISOString(),
      })),
    });
  },
);
