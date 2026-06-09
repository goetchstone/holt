// /app/src/pages/api/mailchimp/campaigns/db.ts
//
// Mailchimp Campaign Impact -- list view data source. Per-row attribution
// (purchasers + revenue within 30 days of engagement) is computed in one
// batch pass per request using lib/campaignAttribution.ts.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  computeCampaignAttribution,
  type EngagementEvent,
  type AttributableOrder,
} from "@/lib/campaignAttribution";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import { logError } from "@/lib/logger";

const ATTRIBUTION_WINDOW_DAYS = 30;
// Walk-ins frequently get added to the Mailchimp list on their first
// purchase. Their follow-on purchases over the next two months are driven
// by being a freshly engaged customer, not by the email itself -- so we
// exclude them from attribution to avoid false credit.
const EXCLUDE_NEW_CUSTOMER_DAYS = 60;

export interface CampaignListAttribution {
  purchasers: number;
  orderCount: number;
  revenue: number;
  revenuePerSend: number;
  openConversionPct: number;
  clickConversionPct: number;
}

function toDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") return res.status(405).end();

  try {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string)?.trim() || "";

    // Optional date-range filter on sentAt. Default: no time filter (caller
    // handles pagination). A 90-day default can be applied at the UI layer.
    const startDate = toDate(req.query.startDate);
    const endDate = toDate(req.query.endDate);

    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" as const } },
        { subject: { contains: search, mode: "insensitive" as const } },
      ];
    }
    if (startDate || endDate) {
      const sentAt: Record<string, Date> = {};
      if (startDate) sentAt.gte = startDate;
      if (endDate) sentAt.lte = endDate;
      where.sentAt = sentAt;
    }

    const [campaigns, total] = await Promise.all([
      prisma.mailchimpCampaign.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ sentAt: { sort: "desc", nulls: "last" } }],
        include: { stats: true },
      }),
      prisma.mailchimpCampaign.count({ where }),
    ]);

    // Batch attribution for this page's campaigns ----------------------------
    const campaignIds = campaigns.map((c) => c.id);
    const attributionMap = new Map<string, CampaignListAttribution>();

    if (campaignIds.length > 0) {
      const activities = await prisma.mailchimpActivity.findMany({
        where: {
          campaignId: { in: campaignIds },
          customerId: { not: null },
          action: { in: ["open", "click"] },
        },
        select: { campaignId: true, customerId: true, action: true, timestamp: true },
      });

      const engagedCustomerIds = Array.from(new Set(activities.map((a) => a.customerId as number)));
      const engagements: EngagementEvent[] = activities
        .filter((a) => a.customerId != null && (a.action === "open" || a.action === "click"))
        .map((a) => ({
          campaignId: a.campaignId,
          customerId: a.customerId as number,
          action: a.action as "open" | "click",
          timestamp: a.timestamp,
        }));

      let orders: AttributableOrder[] = [];
      if (engagedCustomerIds.length > 0 && engagements.length > 0) {
        // Pull any order placed within the relevant attribution window for
        // these customers. We bound by [earliest engagement, latest + window]
        // to keep the query tight.
        const earliest = engagements.reduce(
          (a, b) => (a < b.timestamp ? a : b.timestamp),
          engagements[0].timestamp,
        );
        const latest = engagements.reduce(
          (a, b) => (a > b.timestamp ? a : b.timestamp),
          engagements[0].timestamp,
        );
        const windowEnd = new Date(
          latest.getTime() + ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        );

        const orderRows = await prisma.salesOrder.findMany({
          where: {
            customerId: { in: engagedCustomerIds },
            // RETURNED is included so accounting-return rows
            // (accounting returns) — which hold the negative netPrice lines —
            // net out the corresponding positive lines on the
            // base order or its rewrite chain. Excluding RETURNED
            // double-counts every rewritten sale. See
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

      // firstOrderDate per engaged customer -- feeds the brand-new filter.
      const customerRows = await prisma.customer.findMany({
        where: { id: { in: engagedCustomerIds } },
        select: { id: true, firstOrderDate: true },
      });
      const customerFirstOrderDates = new Map<number, Date>();
      for (const c of customerRows) {
        if (c.firstOrderDate) customerFirstOrderDates.set(c.id, c.firstOrderDate);
      }

      const results = computeCampaignAttribution(engagements, orders, ATTRIBUTION_WINDOW_DAYS, {
        mode: "last-touch",
        excludeNewCustomerDays: EXCLUDE_NEW_CUSTOMER_DAYS,
        customerFirstOrderDates,
      });

      for (const c of campaigns) {
        const r = results.get(c.id);
        const emailsSent = c.stats?.emailsSent ?? 0;
        attributionMap.set(c.id, {
          purchasers: r?.purchasers ?? 0,
          orderCount: r?.orderCount ?? 0,
          revenue: r?.revenue ?? 0,
          revenuePerSend:
            emailsSent > 0 && r ? Math.round((r.revenue / emailsSent) * 100) / 100 : 0,
          openConversionPct: r?.openConversionPct ?? 0,
          clickConversionPct: r?.clickConversionPct ?? 0,
        });
      }
    }

    const enrichedCampaigns = campaigns.map((c) => ({
      ...c,
      attribution: attributionMap.get(c.id) ?? {
        purchasers: 0,
        orderCount: 0,
        revenue: 0,
        revenuePerSend: 0,
        openConversionPct: 0,
        clickConversionPct: 0,
      },
    }));

    res.status(200).json({
      campaigns: enrichedCampaigns,
      total,
      attributionWindowDays: ATTRIBUTION_WINDOW_DAYS,
    });
  } catch (error) {
    logError("Error loading campaigns", error);
    res.status(500).json({ error: "Failed to load campaigns" });
  }
}
