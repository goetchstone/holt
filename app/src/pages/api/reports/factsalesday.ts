// /app/src/pages/api/reports/factsalesday.ts
//
// Returns a daily sales summary aggregated from SalesOrder + OrderLineItem,
// grouped by date and department. Provides total sales, transaction count,
// and average sale per group.

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { getFactSalesDay } from "@/lib/reports/factSalesDay";

// Legacy REST shim. Logic lives in lib/reports/factSalesDay.ts, also exposed via
// the tRPC reports.factSalesDay procedure. Removed once no Pages route uses it.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
