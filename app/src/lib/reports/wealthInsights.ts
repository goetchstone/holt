// /app/src/lib/reports/wealthInsights.ts
//
// Aggregates Windfall enrichment across all customers for the Wealth Insights
// report. Extracted from the Pages API so the App Router page + tRPC procedure
// share one source of truth. Spend sums use SALES_REVENUE_STATUSES (RETURNED
// included so the rewrite chain nets) and exclude CANCELLED lines (rule 33).

import type { Prisma, PrismaClient } from "@prisma/client";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";

export interface CustomerRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  netWorth: number | null;
  wealthTier: string | null;
  orderCount: number;
  totalSpend: number;
  customerLevel: number | null;
  peakCustomerLevel: number | null;
  customerGroup: string | null;
}

export interface WealthInsightsResult {
  totals: { matched: number; withNetWorth: number; avgNetWorth: number };
  tiers: { tier: string; count: number }[];
  signals: { signal: string; count: number }[];
  levels: { level: string; count: number }[];
  recentMovers: CustomerRow[];
  topCustomers: CustomerRow[];
  filteredCustomers: CustomerRow[] | null;
  activeFilter: string | null;
}

export interface WealthInsightsParams {
  signal?: string | null;
  tier?: string | null;
  level?: string | null;
  groups?: string[];
}

const SIGNAL_FIELDS = [
  ["recentMover", "Recent Mover"],
  ["boatOwner", "Boat Owner"],
  ["planeOwner", "Plane Owner"],
  ["multiPropertyOwner", "Multi-property"],
  ["rentalPropertyOwner", "Rental Property"],
  ["philanthropicGiver", "Philanthropic Giver"],
  ["smallBusinessOwner", "Small Business"],
  ["politicalDonor", "Political Donor"],
  ["moneyInMotion", "Money in Motion"],
  ["recentMortgage", "Recent Mortgage"],
  ["trustAssociation", "Trust Association"],
] as const;

export async function getWealthInsights(
  prisma: PrismaClient,
  params: WealthInsightsParams = {},
): Promise<WealthInsightsResult> {
  const signalFilter = params.signal ?? null;
  const tierFilter = params.tier ?? null;
  const levelFilter = params.level ?? null;
  const groupFilters = (params.groups ?? []).filter(Boolean);

  const where: Record<string, unknown> = {};
  if (signalFilter) where[signalFilter] = true;
  if (tierFilter) where.wealthTier = tierFilter;

  const customerWhere: Record<string, unknown> = {};
  if (levelFilter === "DORMANT") {
    customerWhere.customerLevel = null;
    customerWhere.peakCustomerLevel = { not: null };
  } else if (levelFilter) {
    customerWhere.customerLevel = Number.parseInt(levelFilter, 10);
  }
  if (groupFilters.length > 0) {
    customerWhere.customerGroup = { in: groupFilters };
  }

  const enrichmentWhere = {
    ...where,
    ...(Object.keys(customerWhere).length > 0 ? { customer: customerWhere } : {}),
  } as Prisma.WindfallEnrichmentWhereInput;

  const enrichments = await prisma.windfallEnrichment.findMany({
    where: enrichmentWhere,
    include: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          customerLevel: true,
          peakCustomerLevel: true,
          customerGroup: true,
          addresses: { select: { city: true, state: true, zip: true }, take: 1 },
          _count: { select: { salesOrders: true } },
          salesOrders: {
            select: {
              lineItems: {
                select: { netPrice: true },
                where: { lineItemStatus: { not: "CANCELLED" } },
              },
            },
            where: { status: { in: [...SALES_REVENUE_STATUSES] } },
          },
        },
      },
    },
  });

  const withNetWorth = enrichments.filter((e) => e.netWorth != null);
  const totalNetWorth = withNetWorth.reduce((s, e) => s + (e.netWorth ?? 0), 0);

  const tierCounts: Record<string, number> = {};
  for (const e of enrichments) {
    if (e.wealthTier) tierCounts[e.wealthTier] = (tierCounts[e.wealthTier] || 0) + 1;
  }
  const tierOrder = ["ULTRA_HIGH", "VERY_HIGH", "HIGH", "AFFLUENT"];
  const tiers = tierOrder
    .filter((t) => tierCounts[t])
    .map((t) => ({ tier: t, count: tierCounts[t] }));

  const levelCounts: Record<string, number> = {};
  for (const e of enrichments) {
    const lvl = e.customer.customerLevel;
    const peak = e.customer.peakCustomerLevel;
    if (lvl) {
      const label =
        lvl === 4 ? "VIP" : lvl === 3 ? "High Value" : lvl === 2 ? "Frequent" : "Occasional";
      levelCounts[label] = (levelCounts[label] || 0) + 1;
    } else if (peak) {
      levelCounts["Dormant"] = (levelCounts["Dormant"] || 0) + 1;
    }
  }
  const levelOrder = ["VIP", "High Value", "Frequent", "Occasional", "Dormant"];
  const levels = levelOrder
    .filter((l) => levelCounts[l])
    .map((l) => ({ level: l, count: levelCounts[l] }));

  const signals = SIGNAL_FIELDS.map(([field, label]) => ({
    signal: label,
    count: enrichments.filter((e) => e[field as keyof typeof e] === true).length,
  }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);

  function toCustomerRow(e: (typeof enrichments)[number]): CustomerRow {
    const totalSpend = e.customer.salesOrders.reduce(
      (sum, o) => sum + o.lineItems.reduce((ls, li) => ls + Number(li.netPrice ?? 0), 0),
      0,
    );
    return {
      id: e.customer.id,
      firstName: e.customer.firstName,
      lastName: e.customer.lastName,
      email: e.customer.email,
      phone: e.customer.phone,
      city: e.customer.addresses[0]?.city ?? null,
      netWorth: e.netWorth,
      wealthTier: e.wealthTier,
      orderCount: e.customer._count.salesOrders,
      totalSpend: Math.round(totalSpend * 100) / 100,
      customerLevel: e.customer.customerLevel,
      peakCustomerLevel: e.customer.peakCustomerLevel,
      customerGroup: e.customer.customerGroup,
    };
  }

  const recentMovers = enrichments
    .filter((e) => e.recentMover)
    .map(toCustomerRow)
    .sort((a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0));

  const topCustomers = enrichments
    .filter((e) => e.netWorth != null)
    .sort((a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0))
    .slice(0, 50)
    .map(toCustomerRow);

  return {
    totals: {
      matched: enrichments.length,
      withNetWorth: withNetWorth.length,
      avgNetWorth: withNetWorth.length > 0 ? Math.round(totalNetWorth / withNetWorth.length) : 0,
    },
    tiers,
    signals,
    levels,
    recentMovers,
    topCustomers,
    filteredCustomers:
      signalFilter || tierFilter || levelFilter
        ? enrichments.map(toCustomerRow).sort((a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0))
        : null,
    activeFilter: signalFilter || tierFilter || levelFilter || null,
  };
}
