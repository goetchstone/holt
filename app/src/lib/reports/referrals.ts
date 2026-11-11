// /app/src/lib/reports/referrals.ts
//
// Referrals (GAP-08): how customers heard of the store, and who sent them --
// customers, how many of them bought, and what they spent.
//
// Spend is revenue as every report counts it: orders whose status is in
// SALES_REVENUE_STATUSES (returned orders stay in, so returns net out; rule 47)
// and the counted item lines (countedItemLineSql: cancelled and replaced lines
// out, rule 33, and a gift card sold, which isn't revenue), summing netPrice,
// the line total. All time.

import { Prisma, type PrismaClient } from "@prisma/client";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import { countedItemLineSql } from "@/lib/reports/revenueScope";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ReferralTotals {
  customers: number;
  /** Of those, how many have bought anything. */
  buyers: number;
  revenue: number;
}

export interface ReferralSourceRow extends ReferralTotals {
  /** Null: no source recorded. */
  sourceId: number | null;
  name: string;
  isActive: boolean;
}

export interface ReferrerRow extends ReferralTotals {
  referrerId: number;
  name: string;
}

export interface ReferralReport {
  bySource: ReferralSourceRow[];
  referrers: ReferrerRow[];
}

const ORDER_COUNTED = Prisma.join([...SALES_REVENUE_STATUSES]);

/** Spend per group, from customers through their counted orders and lines. */
function totalsSql(groupBy: Prisma.Sql, where: Prisma.Sql) {
  return Prisma.sql`
    SELECT ${groupBy} AS "key",
           COUNT(DISTINCT c.id)::int AS customers,
           COUNT(DISTINCT o."customerId")::int AS buyers,
           COALESCE(SUM(li."netPrice"), 0)::text AS revenue
    FROM "Customer" c
    LEFT JOIN "SalesOrder" o
      ON o."customerId" = c.id AND o.status::text IN (${ORDER_COUNTED})
    LEFT JOIN "OrderLineItem" li
      ON li."salesOrderId" = o.id AND ${countedItemLineSql("li")}
    ${where}
    GROUP BY 1`;
}

interface TotalsRow {
  key: number | null;
  customers: number;
  buyers: number;
  revenue: string;
}

const money = (v: string) => Math.round(Number(v) * 100) / 100;

export async function getReferralReport(
  db: Db,
  opts: { referrerLimit?: number } = {},
): Promise<ReferralReport> {
  const [sourceTotals, referrerTotals, sources] = await Promise.all([
    db.$queryRaw<TotalsRow[]>(totalsSql(Prisma.sql`c."referralSourceId"`, Prisma.empty)),
    db.$queryRaw<TotalsRow[]>(
      totalsSql(
        Prisma.sql`c."referredByCustomerId"`,
        Prisma.sql`WHERE c."referredByCustomerId" IS NOT NULL`,
      ),
    ),
    db.referralSource.findMany({
      select: { id: true, name: true, isActive: true, sortOrder: true },
    }),
  ]);

  const totalsBySource = new Map(sourceTotals.map((t) => [t.key, t]));
  const bySource: ReferralSourceRow[] = sources
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((s) => {
      const t = totalsBySource.get(s.id);
      return {
        sourceId: s.id,
        name: s.name,
        isActive: s.isActive,
        customers: t?.customers ?? 0,
        buyers: t?.buyers ?? 0,
        revenue: money(t?.revenue ?? "0"),
      };
    });
  const unrecorded = totalsBySource.get(null);
  if (unrecorded) {
    bySource.push({
      sourceId: null,
      name: "Not recorded",
      isActive: true,
      customers: unrecorded.customers,
      buyers: unrecorded.buyers,
      revenue: money(unrecorded.revenue),
    });
  }

  const top = referrerTotals
    .map((t) => ({ ...t, revenueN: money(t.revenue) }))
    .sort(
      (a, b) => b.customers - a.customers || b.revenueN - a.revenueN || (a.key ?? 0) - (b.key ?? 0),
    )
    .slice(0, opts.referrerLimit ?? 50);
  const names = new Map(
    (
      await db.customer.findMany({
        where: { id: { in: top.map((t) => t.key as number) } },
        select: { id: true, firstName: true, lastName: true, tradeCompanyName: true },
      })
    ).map((c) => [
      c.id,
      c.tradeCompanyName || [c.firstName, c.lastName].filter(Boolean).join(" ") || `#${c.id}`,
    ]),
  );
  const referrers: ReferrerRow[] = top.map((t) => ({
    referrerId: t.key as number,
    name: names.get(t.key as number) ?? `#${t.key}`,
    customers: t.customers,
    buyers: t.buyers,
    revenue: t.revenueN,
  }));

  return { bySource, referrers };
}
