// /app/src/pages/api/reports/on-hold.ts
//
// The On hold report as data (lib/reports/onHold.ts): every quote line holding
// floor stock today, soonest to end first. ?format=csv answers a CSV.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getOnHoldReport, onHoldCsv } from "@/lib/reports/onHold";
import { quoteHoldContext } from "@/lib/sales/quoteHolds";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { today } = await quoteHoldContext();
    const rows = await getOnHoldReport(prisma, today);
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="on-hold.csv"');
      return res.status(200).send(onHoldCsv(rows));
    }
    return res.status(200).json({ today, rows });
  } catch (error) {
    logError("Error building the On hold report", error);
    return res.status(500).json({ error: "Failed to build the On hold report" });
  }
}

export default requirePermission("reporting.read", handler);
