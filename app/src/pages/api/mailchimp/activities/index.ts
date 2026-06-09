// /app/src/pages/api/mailchimp/activities/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
