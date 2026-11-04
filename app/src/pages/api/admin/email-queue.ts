// /app/src/pages/api/admin/email-queue.ts
//
// GET -- recent email-queue rows + per-status counts + whether SMTP is
// configured, for the admin Email viewer, and the same for texts (GAP-12).
// ADMIN-gated.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { isEmailConfigured } from "@/lib/email/config";
import { isSmsConfigured } from "@/lib/sms";

export default requirePermission(
  "admin.integrations",
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    const [rows, grouped, configured, textRows, textGrouped, textingConfigured] = await Promise.all(
      [
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
        prisma.smsQueue.findMany({
          where: { organizationId: DEFAULT_ORG_ID },
          orderBy: { created: "desc" },
          take: 100,
          select: {
            id: true,
            toPhone: true,
            body: true,
            templateKey: true,
            status: true,
            attempts: true,
            lastError: true,
            sentAt: true,
            deliveredAt: true,
            created: true,
          },
        }),
        prisma.smsQueue.groupBy({
          by: ["status"],
          where: { organizationId: DEFAULT_ORG_ID },
          _count: true,
        }),
        isSmsConfigured(),
      ],
    );
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
    const textCounts = Object.fromEntries(textGrouped.map((g) => [g.status, g._count]));
    return res.status(200).json({
      rows,
      counts,
      configured,
      texts: { rows: textRows, counts: textCounts, configured: textingConfigured },
    });
  },
);
