// /app/src/lib/campaignAttribution.ts
//
// Pure attribution engine for the Mailchimp Campaign Impact report.
//
// Answers: "of the customers who opened or clicked this campaign, how many
// bought something within N days, for how much money, in which departments?"
//
// Two modes via `AttributionOptions.mode`:
//   - "shared" (default) -- a customer who engaged with three campaigns before
//     buying contributes to all three. Correct for per-campaign conversion
//     rate. Summed across campaigns it double-counts.
//   - "last-touch" -- each order credits exactly ONE campaign: the most
//     recent engagement that still falls within the 30-day window before the
//     order date. Summed totals are honest.
//
// Brand-new-customer filter (`excludeNewCustomerDays`) drops customers from a
// campaign's attribution when their `firstOrderDate` falls within N days
// before that campaign's first engagement. Walk-ins who get added to the
// email list on their first purchase would otherwise inflate the next
// campaign's attribution with purchases they were already making.
//
// Cancelled line items are excluded from the revenue sum (CLAUDE.md rule 33).
// netPrice is already a line total (CLAUDE.md netPrice invariant) -- do not
// multiply by quantity.

export interface EngagementEvent {
  campaignId: string;
  customerId: number;
  action: "open" | "click";
  timestamp: Date;
}

export interface AttributableOrder {
  customerId: number;
  orderDate: Date;
  // Pre-filtered to active (non-cancelled) line items by the caller.
  lineItems: { netPrice: number; departmentName: string | null }[];
}

export interface TopPurchaser {
  customerId: number;
  revenue: number;
  orderCount: number;
}

export interface DepartmentRevenue {
  departmentName: string;
  revenue: number;
  orderCount: number;
}

export interface CampaignAttributionResult {
  campaignId: string;
  windowDays: number;
  uniqueOpeners: number;
  uniqueClickers: number;
  uniqueEngaged: number; // opened OR clicked
  openersWhoPurchased: number;
  clickersWhoPurchased: number;
  purchasers: number; // opened OR clicked AND purchased
  orderCount: number;
  revenue: number;
  avgOrderValue: number;
  openConversionPct: number; // openersWhoPurchased / uniqueOpeners, 1 decimal
  clickConversionPct: number;
  revenueByDepartment: DepartmentRevenue[];
  topPurchasers: TopPurchaser[];
}

export interface AttributionOptions {
  // "shared" = non-exclusive per-campaign credit (default). "last-touch" =
  // each order credits exactly one campaign: the latest engagement within
  // the 30-day window before the order.
  mode?: "shared" | "last-touch";
  // Exclude customers whose firstOrderDate falls within N days before a
  // campaign's first engagement. Set to 0 (default) to disable.
  excludeNewCustomerDays?: number;
  // Required when excludeNewCustomerDays > 0. customerId -> firstOrderDate.
  // Missing entries are treated as "no history known" -> no exclusion.
  customerFirstOrderDates?: Map<number, Date>;
}

interface CustomerEngagement {
  firstOpenAt: Date | null;
  firstClickAt: Date | null;
  firstEngagementAt: Date; // min of open/click
}

// Group engagement events by (campaignId, customerId). We only care about
// each customer's earliest open and earliest click per campaign -- later
// opens are noise for attribution.
function groupEngagements(
  engagements: EngagementEvent[],
): Map<string, Map<number, CustomerEngagement>> {
  const byCampaign = new Map<string, Map<number, CustomerEngagement>>();
  for (const e of engagements) {
    let byCustomer = byCampaign.get(e.campaignId);
    if (!byCustomer) {
      byCustomer = new Map();
      byCampaign.set(e.campaignId, byCustomer);
    }
    const existing = byCustomer.get(e.customerId);
    if (!existing) {
      byCustomer.set(e.customerId, {
        firstOpenAt: e.action === "open" ? e.timestamp : null,
        firstClickAt: e.action === "click" ? e.timestamp : null,
        firstEngagementAt: e.timestamp,
      });
      continue;
    }
    if (e.action === "open" && (!existing.firstOpenAt || e.timestamp < existing.firstOpenAt)) {
      existing.firstOpenAt = e.timestamp;
    }
    if (e.action === "click" && (!existing.firstClickAt || e.timestamp < existing.firstClickAt)) {
      existing.firstClickAt = e.timestamp;
    }
    if (e.timestamp < existing.firstEngagementAt) {
      existing.firstEngagementAt = e.timestamp;
    }
  }
  return byCampaign;
}

// Index orders by customerId for O(1) lookup during per-campaign attribution.
function groupOrdersByCustomer(orders: AttributableOrder[]): Map<number, AttributableOrder[]> {
  const map = new Map<number, AttributableOrder[]>();
  for (const o of orders) {
    let list = map.get(o.customerId);
    if (!list) {
      list = [];
      map.set(o.customerId, list);
    }
    list.push(o);
  }
  return map;
}

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const UNKNOWN_DEPT = "(unassigned)";

export function computeCampaignAttribution(
  engagements: EngagementEvent[],
  orders: AttributableOrder[],
  windowDays: number,
  options: AttributionOptions = {},
): Map<string, CampaignAttributionResult> {
  const mode = options.mode ?? "shared";
  const excludeNewDays = options.excludeNewCustomerDays ?? 0;
  const firstOrderDates = options.customerFirstOrderDates;
  const byCampaign = groupEngagements(engagements);
  const ordersByCustomer = groupOrdersByCustomer(orders);
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const results = new Map<string, CampaignAttributionResult>();

  // Last-touch: for each order, precompute the single winning campaign =
  // the latest engagement <= orderDate that still falls inside the window.
  // An order with no qualifying engagement has no winner and is dropped.
  const winningCampaignByOrder = new Map<AttributableOrder, string>();
  if (mode === "last-touch") {
    const engagementsByCustomer = new Map<number, Array<{ campaignId: string; time: Date }>>();
    for (const e of engagements) {
      const list = engagementsByCustomer.get(e.customerId) ?? [];
      list.push({ campaignId: e.campaignId, time: e.timestamp });
      engagementsByCustomer.set(e.customerId, list);
    }
    for (const list of engagementsByCustomer.values()) {
      list.sort((a, b) => b.time.getTime() - a.time.getTime());
    }
    for (const order of orders) {
      const list = engagementsByCustomer.get(order.customerId);
      if (!list) continue;
      for (const e of list) {
        if (e.time.getTime() > order.orderDate.getTime()) continue;
        if (order.orderDate.getTime() - e.time.getTime() > windowMs) break;
        winningCampaignByOrder.set(order, e.campaignId);
        break;
      }
    }
  }

  for (const [campaignId, byCustomer] of byCampaign) {
    const openers = new Set<number>();
    const clickers = new Set<number>();
    const purchasers = new Set<number>();
    const openerPurchasers = new Set<number>();
    const clickerPurchasers = new Set<number>();
    const customerRevenue = new Map<number, { revenue: number; orderCount: number }>();
    const deptTotals = new Map<string, { revenue: number; orderCount: number }>();
    let totalRevenue = 0;
    let totalOrderCount = 0;

    for (const [customerId, engagement] of byCustomer) {
      // Brand-new-customer filter: if the customer's first-ever order was
      // within excludeNewDays before this engagement, they were probably
      // added to the list because of that purchase. Skip.
      if (excludeNewDays > 0 && firstOrderDates) {
        const firstOrder = firstOrderDates.get(customerId);
        if (firstOrder) {
          const daysBefore =
            (engagement.firstEngagementAt.getTime() - firstOrder.getTime()) / (24 * 60 * 60 * 1000);
          if (daysBefore >= 0 && daysBefore < excludeNewDays) continue;
        }
      }

      if (engagement.firstOpenAt) openers.add(customerId);
      if (engagement.firstClickAt) clickers.add(customerId);

      const customerOrders = ordersByCustomer.get(customerId);
      if (!customerOrders || customerOrders.length === 0) continue;

      const windowEnd = new Date(engagement.firstEngagementAt.getTime() + windowMs);
      const inWindow = customerOrders.filter(
        (o) => o.orderDate >= engagement.firstEngagementAt && o.orderDate <= windowEnd,
      );
      const attributed =
        mode === "last-touch"
          ? inWindow.filter((o) => winningCampaignByOrder.get(o) === campaignId)
          : inWindow;
      if (attributed.length === 0) continue;

      purchasers.add(customerId);
      if (engagement.firstOpenAt) openerPurchasers.add(customerId);
      if (engagement.firstClickAt) clickerPurchasers.add(customerId);

      let thisCustomerRevenue = 0;
      for (const o of attributed) {
        for (const li of o.lineItems) {
          const amt = li.netPrice;
          thisCustomerRevenue += amt;
          totalRevenue += amt;
          const dept = li.departmentName || UNKNOWN_DEPT;
          const entry = deptTotals.get(dept) ?? { revenue: 0, orderCount: 0 };
          entry.revenue += amt;
          deptTotals.set(dept, entry);
        }
      }
      totalOrderCount += attributed.length;
      // Count one order per dept appearance (not per line item).
      const deptsThisChain = new Set<string>();
      for (const o of attributed) {
        for (const li of o.lineItems) {
          const dept = li.departmentName || UNKNOWN_DEPT;
          if (!deptsThisChain.has(`${customerId}:${o.orderDate.toISOString()}:${dept}`)) {
            deptsThisChain.add(`${customerId}:${o.orderDate.toISOString()}:${dept}`);
            const entry = deptTotals.get(dept)!;
            entry.orderCount += 1;
          }
        }
      }
      customerRevenue.set(customerId, {
        revenue: thisCustomerRevenue,
        orderCount: attributed.length,
      });
    }

    const revenueByDepartment: DepartmentRevenue[] = Array.from(deptTotals.entries())
      .map(([departmentName, { revenue, orderCount }]) => ({
        departmentName,
        revenue: round2(revenue),
        orderCount,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const topPurchasers: TopPurchaser[] = Array.from(customerRevenue.entries())
      .map(([customerId, v]) => ({
        customerId,
        revenue: round2(v.revenue),
        orderCount: v.orderCount,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    results.set(campaignId, {
      campaignId,
      windowDays,
      uniqueOpeners: openers.size,
      uniqueClickers: clickers.size,
      uniqueEngaged: new Set([...openers, ...clickers]).size,
      openersWhoPurchased: openerPurchasers.size,
      clickersWhoPurchased: clickerPurchasers.size,
      purchasers: purchasers.size,
      orderCount: totalOrderCount,
      revenue: round2(totalRevenue),
      avgOrderValue: totalOrderCount > 0 ? round2(totalRevenue / totalOrderCount) : 0,
      openConversionPct: pct(openerPurchasers.size, openers.size),
      clickConversionPct: pct(clickerPurchasers.size, clickers.size),
      revenueByDepartment,
      topPurchasers,
    });
  }

  return results;
}
