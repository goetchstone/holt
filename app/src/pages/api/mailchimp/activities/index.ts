// /app/src/pages/api/mailchimp/activities/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  try {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string)?.trim() || "";

    const skip = (page - 1) * limit;

    const where: any = search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { action: { contains: search, mode: "insensitive" as const } },
            { customer: { firstName: { contains: search, mode: "insensitive" as const } } },
            { customer: { lastName: { contains: search, mode: "insensitive" as const } } },
            { customer: { email: { contains: search, mode: "insensitive" as const } } },
            { campaign: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {};

    const [activity, total] = await Promise.all([
      prisma.mailchimpActivity.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer: {
            select: { email: true, firstName: true, lastName: true },
          },
          campaign: {
            select: { id: true, name: true, subject: true, sentAt: true }, // Include campaign ID for linking
          },
        },
        orderBy: { timestamp: "desc" },
      }),
      prisma.mailchimpActivity.count({ where }),
    ]);

    // Map customer/campaign names for easier frontend display
    const mappedActivity = activity.map((act) => ({
      ...act,
      customerFullName: act.customer
        ? `${act.customer.firstName || ""} ${act.customer.lastName || ""}`.trim()
        : act.email,
      campaignName: act.campaign?.name,
      campaignId: act.campaign?.id, // Pass campaign ID for detail linking
    }));

    res.status(200).json({ activity: mappedActivity, total });
  } catch (err) {
    logError("Failed to fetch activity", err);
    res.status(500).json({ error: "Failed to load activity" });
  }
}

// Per-customer email engagement, joined to customer name/email. TWO surfaces
// read this, and the gate has to serve the wider of them: the Reports activity
// log (/app/reports/mailchimp/activity) AND the Email Activity panel on
// customer detail (/app/sales/customers/[id]), which calls it with
// `search=<email>`. That panel sits behind the Sales hub, whose floor is
// `customer.read` (navPermissions.ts) -- Register, Warehouse and Installer
// reach it and do NOT hold `reporting.read`, so gating this on the Reports
// permission would blank the panel for them. `customer.read` is also what the
// sibling that does this exact job uses: customers/[id]/email-stats.ts reads
// the same mailchimpActivity rows for one customer's email.
export default requirePermission("customer.read", handler);
