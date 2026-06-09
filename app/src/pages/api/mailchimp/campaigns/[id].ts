// /app/src/pages/api/mailchimp/campaigns/[id].ts
//
// Mailchimp Campaign Impact -- per-campaign detail + attribution breakdown.
// Returns the campaign metadata plus an `attribution` block with purchaser /
// revenue / department-rollup / top-purchaser data (30-day window from
// first engagement). Uses lib/campaignAttribution.ts.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  computeCampaignAttribution,
  type EngagementEvent,
  type AttributableOrder,
  type CampaignAttributionResult,
} from "@/lib/campaignAttribution";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import { logError } from "@/lib/logger";

const ATTRIBUTION_WINDOW_DAYS = 30;
const EXCLUDE_NEW_CUSTOMER_DAYS = 60;

export interface CampaignDetailAttribution extends CampaignAttributionResult {
  unlinkedEngagements: number;
  topPurchasers: Array<{
    customerId: number;
    name: string | null;
    email: string | null;
    revenue: number;
    orderCount: number;
  }>;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") return res.status(405).end();

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid campaign ID" });

  try {
    const campaign = await prisma.mailchimpCampaign.findUnique({
      where: { id },
      include: {
        stats: true,
        _count: { select: { activities: true } },
      },
    });

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // Pull engagements for this campaign. Unlinked (no customerId) rows can't
    // attribute -- we count them so the UI can show a blind-spot footnote.
    const activities = await prisma.mailchimpActivity.findMany({
      where: { campaignId: id, action: { in: ["open", "click"] } },
      select: { campaignId: true, customerId: true, action: true, timestamp: true },
    });
    const unlinkedEngagements = activities.filter((a) => a.customerId == null).length;
    const linked = activities.filter((a) => a.customerId != null);

    const engagements: EngagementEvent[] = linked.map((a) => ({
      campaignId: a.campaignId,
      customerId: a.customerId as number,
      action: a.action as "open" | "click",
      timestamp: a.timestamp,
    }));

    let orders: AttributableOrder[] = [];
    let topPurchasersWithNames: CampaignDetailAttribution["topPurchasers"] = [];

    if (engagements.length > 0) {
      const engagedCustomerIds = Array.from(new Set(engagements.map((e) => e.customerId)));
      const earliest = engagements.reduce(
        (a, b) => (a < b.timestamp ? a : b.timestamp),
        engagements[0].timestamp,
      );
      const latest = engagements.reduce(
        (a, b) => (a > b.timestamp ? a : b.timestamp),
        engagements[0].timestamp,
      );
      const windowEnd = new Date(latest.getTime() + ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const orderRows = await prisma.salesOrder.findMany({
        where: {
          customerId: { in: engagedCustomerIds },
          // RETURNED is included so accounting-return rows
          // (accounting returns) net the rewrite chain. See
          // `lib/salesOrderRevenue.ts` for the full rationale.
          status: { in: [...SALES_REVENUE_STATUSES] },
          orderDate: { gte: earliest, lte: windowEnd },
        },
        select: {
          customerId: true,
          orderDate: true,
          lineItems: {
            where: { lineItemStatus: { not: "CANCELLED" } },
            select: {
              netPrice: true,
              product: { select: { department: { select: { name: true } } } },
            },
          },
        },
      });

      orders = orderRows
        .filter((o) => o.customerId != null && o.orderDate != null)
        .map((o) => ({
          customerId: o.customerId as number,
          orderDate: o.orderDate as Date,
          lineItems: o.lineItems.map((li) => ({
            netPrice: Number(li.netPrice ?? 0),
            departmentName: li.product?.department?.name ?? null,
          })),
        }));
    }

    // Cross-campaign engagements for the same customers. Last-touch needs
    // this context -- otherwise a purchase that really belongs to a LATER
    // campaign would be credited here. Without it the detail page would
    // disagree with the list page.
    const engagedCustomerIds = Array.from(new Set(engagements.map((e) => e.customerId)));
    let allEngagements: EngagementEvent[] = engagements;
    const customerFirstOrderDates = new Map<number, Date>();
    if (engagedCustomerIds.length > 0) {
      const earliestEng = engagements.reduce(
        (a, b) => (a < b.timestamp ? a : b.timestamp),
        engagements[0].timestamp,
      );
      const latestEng = engagements.reduce(
        (a, b) => (a > b.timestamp ? a : b.timestamp),
        engagements[0].timestamp,
      );
      const windowEnd = new Date(
        latestEng.getTime() + ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const [otherActivities, customerRows] = await Promise.all([
        prisma.mailchimpActivity.findMany({
          where: {
            customerId: { in: engagedCustomerIds },
            action: { in: ["open", "click"] },
            timestamp: { gte: earliestEng, lte: windowEnd },
          },
          select: { campaignId: true, customerId: true, action: true, timestamp: true },
        }),
        prisma.customer.findMany({
          where: { id: { in: engagedCustomerIds } },
          select: { id: true, firstOrderDate: true },
        }),
      ]);
      allEngagements = otherActivities
        .filter((a) => a.customerId != null)
        .map((a) => ({
          campaignId: a.campaignId,
          customerId: a.customerId as number,
          action: a.action as "open" | "click",
          timestamp: a.timestamp,
        }));
      for (const c of customerRows) {
        if (c.firstOrderDate) customerFirstOrderDates.set(c.id, c.firstOrderDate);
      }
    }

    const results = computeCampaignAttribution(allEngagements, orders, ATTRIBUTION_WINDOW_DAYS, {
      mode: "last-touch",
      excludeNewCustomerDays: EXCLUDE_NEW_CUSTOMER_DAYS,
      customerFirstOrderDates,
    });
    const attribution = results.get(id);

    // Enrich topPurchasers with names so the UI doesn't need a second query.
    if (attribution && attribution.topPurchasers.length > 0) {
      const customers = await prisma.customer.findMany({
        where: { id: { in: attribution.topPurchasers.map((t) => t.customerId) } },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      const map = new Map(customers.map((c) => [c.id, c]));
      topPurchasersWithNames = attribution.topPurchasers.map((t) => {
        const c = map.get(t.customerId);
        const name = c ? [c.firstName, c.lastName].filter(Boolean).join(" ") || null : null;
        return {
          customerId: t.customerId,
          name,
          email: c?.email ?? null,
          revenue: t.revenue,
          orderCount: t.orderCount,
        };
      });
    }

    const attributionBlock: CampaignDetailAttribution | null = attribution
      ? { ...attribution, unlinkedEngagements, topPurchasers: topPurchasersWithNames }
      : null;

    res.status(200).json({ ...campaign, attribution: attributionBlock });
  } catch (err) {
    logError("Failed to load campaign", err);
    res.status(500).json({ error: "Failed to load campaign" });
  }
}
