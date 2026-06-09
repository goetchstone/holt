// /app/src/pages/api/admin/email-queue.ts
//
// GET -- recent email-queue rows + per-status counts + whether SMTP is
// configured, for the admin Email viewer. ADMIN-gated.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { isEmailConfigured } from "@/lib/email/config";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    const [rows, grouped, configured] = await Promise.all([
      prisma.emailQueue.findMany({
        where: { organizationId: DEFAULT_ORG_ID },
        orderBy: { created: "desc" },
        take: 100,
        select: {
          id: true,
          toAddress: true,
          subject: true,
          templateKey: true,
          status: true,
          attempts: true,
          lastError: true,
          sentAt: true,
          created: true,
        },
      }),
      prisma.emailQueue.groupBy({
        by: ["status"],
        where: { organizationId: DEFAULT_ORG_ID },
        _count: true,
      }),
      isEmailConfigured(),
    ]);
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
    return res.status(200).json({ rows, counts, configured });
  },
);
