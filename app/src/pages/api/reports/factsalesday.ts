// /app/src/pages/api/reports/factsalesday.ts
//
// Returns a daily sales summary aggregated from SalesOrder + OrderLineItem,
// grouped by date and department. Provides total sales, transaction count,
// and average sale per group.

import { requirePermission } from "@/lib/auth/requireAuth";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { getFactSalesDay } from "@/lib/reports/factSalesDay";

// Legacy REST shim. Logic lives in lib/reports/factSalesDay.ts, also exposed via
// the tRPC reports.factSalesDay procedure. Removed once no Pages route uses it.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    return res.status(200).json(await getFactSalesDay(prisma));
  } catch (error) {
    logError("Error in factsalesday API", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export default requirePermission("reporting.read", handler);
