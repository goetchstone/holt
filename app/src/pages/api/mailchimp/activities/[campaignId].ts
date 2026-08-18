// /app/src/pages/api/mailchimp/activities/[campaignId].ts

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const { campaignId } = req.query;
  if (!campaignId || typeof campaignId !== "string") {
    return res.status(400).json({ error: "Missing or invalid campaignId" });
  }

  const page = Number.parseInt(req.query.page as string) || 1;
  const limit = Number.parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;
  const action = typeof req.query.action === "string" ? req.query.action : undefined;

  try {
    const where = { campaignId, ...(action ? { action } : {}) };

    const [activities, total] = await Promise.all([
      prisma.mailchimpActivity.findMany({
        where,
        select: {
          email: true,
          action: true,
          timestamp: true,
          customer: {
            select: { firstName: true, lastName: true },
          },
        },
        orderBy: { timestamp: "desc" },
        skip,
        take: limit,
      }),
      prisma.mailchimpActivity.count({ where }),
    ]);

    res.status(200).json({ activities, total });
  } catch (err) {
    logError("Failed to fetch activity", err);
    res.status(500).json({ error: "Failed to load activity" });
  }
}

// The engagement log on the campaign detail report
// (/app/reports/mailchimp/campaigns/[id]), read on screen. That page is a bare
// requirePage(), so the Reports nav entry is the audience signal:
// `reporting.read` (navPermissions.ts). Same call as dashboard/weekly.ts, the
// other on-screen report read. NOT `marketing.read` -- the mailchimp surfaces
// live under Reports, there is no Marketing nav entry, and marketing.read would
// drop Designer, who runs these reports today.
export default requirePermission("reporting.read", handler);
