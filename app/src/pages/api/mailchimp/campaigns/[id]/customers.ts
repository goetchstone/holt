// /app/src/pages/api/mailchimp/campaigns/[id]/customers.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  const { id } = req.query;
  const campaignId = id as string;

  const page = Number.parseInt(req.query.page as string) || 1;
  const limit = Number.parseInt(req.query.limit as string) || 10;
  const skip = (page - 1) * limit;

  try {
    // Step 1: Find all unique emails for the given campaign from MailchimpActivity
    const activities = await prisma.mailchimpActivity.findMany({
      where: {
        campaignId: campaignId,
      },
      select: {
        email: true,
      },
      distinct: ["email"],
    });

    const emails = activities.map((activity) => activity.email);

    // Step 2: Find all customers that match the collected emails
    const customers = await prisma.customer.findMany({
      where: {
        email: {
          in: emails,
        },
      },
      include: {
        addresses: true,
        externalIds: true,
      },
      skip: skip,
      take: limit,
    });

    const totalCustomers = await prisma.customer.count({
      where: {
        email: {
          in: emails,
        },
      },
    });

    res.status(200).json({
      data: customers,
      totalPages: Math.ceil(totalCustomers / limit),
    });
  } catch (error) {
    logError("Error fetching customers for campaign", error);
    res.status(500).json({ error: "Failed to fetch customers for campaign" });
  }
}

export default handler;
