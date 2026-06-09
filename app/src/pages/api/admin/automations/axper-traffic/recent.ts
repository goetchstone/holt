// /app/src/pages/api/admin/automations/axper-traffic/recent.ts
//
// Returns the last N TrafficSyncLog rows for the admin Axper-traffic
// page. ADMIN/MANAGER only — keeps cron-internals out of designer
// sight even though the data isn't sensitive.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    const limit = Math.min(Number.parseInt((req.query.limit as string) || "20", 10), 100);
    const logs = await prisma.trafficSyncLog.findMany({
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return res.status(200).json({ logs });
  },
);
