// /app/src/pages/api/reports/open-orders.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { getOpenOrdersReport, type OpenOrdersReport } from "@/lib/reports/openOrders";

// Legacy REST shim. The report logic now lives in lib/reports/openOrders.ts and
// is also exposed via the tRPC reports.openOrders procedure (App Router). This
// handler stays during the migration so the existing Pages-Router page keeps
// working; it's removed once that page is fully ported + cut over.
export type OpenOrdersResponse = OpenOrdersReport;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const response = await getOpenOrdersReport(prisma);
    return res.status(200).json(response);
  } catch (error) {
    logError("Error in open-orders API", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
