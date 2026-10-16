// /app/src/pages/api/reports/oversold.ts
//
// The Oversold report as data (lib/reports/oversold.ts): open shortfalls
// grouped by product, each with its suggested fix. ?storeLocationId= narrows to
// one store; ?format=csv answers a CSV, one row per order short.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getOversoldReport, oversoldCsv } from "@/lib/reports/oversold";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const storeLocationId = req.query.storeLocationId ? Number(req.query.storeLocationId) : null;
  if (storeLocationId != null && !Number.isInteger(storeLocationId)) {
    return res.status(400).json({ error: "storeLocationId must be a store id." });
  }
  try {
    const rows = await getOversoldReport(prisma, { storeLocationId });
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="oversold.csv"');
      return res.status(200).send(oversoldCsv(rows));
    }
    return res.status(200).json({ rows });
  } catch (error) {
    logError("Error building the Oversold report", error);
    return res.status(500).json({ error: "Failed to build the Oversold report" });
  }
}

export default requirePermission("reporting.read", handler);
