// /app/src/pages/api/mailchimp/campaigns/[id]/customers.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
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

// Bulk customer-list read: every Customer row that engaged the campaign, whole
// record, with `addresses` and `externalIds` included -- name, email, phone and
// street address for the segment. The sibling that hands out the customer book
// with those same relations is exports/windfall-customers.ts, gated on
// `reporting.export`, which is verbatim "Download report data and customer
// lists" and is flagged sensitive in the catalog. Choosing the sensitive
// permission costs no working surface here: nothing in the app calls this
// endpoint -- it has no UI, so there is no page audience to over-gate.
export default requirePermission("reporting.export", handler);
