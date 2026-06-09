// /app/src/pages/api/customers/[id]/email-stats.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { id } = req.query;
  const customerId = Number.parseInt(id as string);

  if (Number.isNaN(customerId)) {
    return res.status(400).json({ error: "Invalid customer ID." });
  }

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { email: true },
    });

    if (!customer) {
      return res.status(404).json({ error: "Customer not found." });
    }

    if (!customer.email) {
      return res.status(200).json({
        totalSent: 0,
        totalOpens: 0,
        openRate: 0,
        totalClicks: 0,
        clickRate: 0,
      });
    }

    const activities = await prisma.mailchimpActivity.findMany({
      where: { email: { equals: customer.email, mode: "insensitive" } },
      select: { action: true, campaignId: true },
    });

    // Mailchimp activity records don't include a "sent" action -- sends are
    // tracked at the campaign level. Use distinct campaign count as the sent proxy.
    const totalSent = new Set(activities.map((a) => a.campaignId)).size;
    const totalOpens = activities.filter((a) => a.action === "open").length;
    const totalClicks = activities.filter((a) => a.action === "click").length;

    const openRate = totalSent > 0 ? Math.round((totalOpens / totalSent) * 100) : 0;
    const clickRate = totalSent > 0 ? Math.round((totalClicks / totalSent) * 100) : 0;

    return res.status(200).json({
      totalSent,
      totalOpens,
      openRate,
      totalClicks,
      clickRate,
    });
  } catch (error) {
    logError("Error fetching email stats", error);
    return res.status(500).json({ error: "Failed to fetch email stats." });
  }
}

export default requireAuthWithRole(
  ["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "MARKETING", "REGISTER", "INSTALLER"],
  handler,
);
