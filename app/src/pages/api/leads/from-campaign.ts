// /app/src/pages/api/leads/from-campaign.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const userEmail = session.user.email;
  const { campaignId } = req.body;

  if (!campaignId) {
    return res.status(400).json({ error: "campaignId is required" });
  }

  try {
    // Fetch click activities for this campaign, grouped by unique email
    const activities = await prisma.mailchimpActivity.findMany({
      where: {
        campaignId,
        action: "click",
      },
      select: {
        email: true,
      },
      distinct: ["email"],
    });

    if (activities.length === 0) {
      return res.json({ created: 0, message: "No click activity found for this campaign" });
    }

    const emails = activities.map((a) => a.email.toLowerCase());

    // Check which leads already exist for this campaign (dedup)
    const existingLeads = await prisma.lead.findMany({
      where: {
        campaignId,
        email: { in: emails, mode: "insensitive" },
      },
      select: { email: true },
    });

    const existingEmails = new Set(existingLeads.map((l) => l.email?.toLowerCase()));
    const newEmails = emails.filter((e) => !existingEmails.has(e));

    if (newEmails.length === 0) {
      return res.json({ created: 0, message: "All leads already exist for this campaign" });
    }

    // Batch-lookup customers by email (case-insensitive)
    const customers = await prisma.customer.findMany({
      where: {
        email: { in: newEmails, mode: "insensitive" },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        primaryDesignerId: true,
      },
    });

    const customerByEmail = new Map(customers.map((c) => [c.email?.toLowerCase() ?? "", c]));

    // Get campaign name for sourceDetail
    const campaign = await prisma.mailchimpCampaign.findUnique({
      where: { id: campaignId },
      select: { name: true, subject: true },
    });

    const sourceDetail = campaign
      ? `Clicked: ${campaign.subject || campaign.name || campaignId}`
      : `Clicked: campaign ${campaignId}`;

    // Create leads
    const leadsData = newEmails.map((email) => {
      const customer = customerByEmail.get(email);
      const autoAssign = customer?.primaryDesignerId ?? null;

      return {
        source: "MAILCHIMP_CLICK" as const,
        status: autoAssign ? ("ASSIGNED" as const) : ("NEW" as const),
        email,
        firstName: customer?.firstName ?? null,
        lastName: customer?.lastName ?? null,
        customerId: customer?.id ?? null,
        campaignId,
        sourceDetail,
        assignedToId: autoAssign,
        assignedAt: autoAssign ? new Date() : null,
        createdBy: userEmail,
      };
    });

    const result = await prisma.lead.createMany({ data: leadsData });

    return res.json({
      created: result.count,
      autoAssigned: leadsData.filter((l) => l.assignedToId).length,
    });
  } catch (err) {
    logError("Failed to generate leads from campaign", err);
    return res.status(500).json({ error: "Failed to generate leads" });
  }
}
