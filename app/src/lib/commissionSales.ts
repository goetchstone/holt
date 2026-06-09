// /app/src/lib/commissionSales.ts
//
// Shared sales-aggregation helpers for commission code. Both the
// live preview (`api/admin/reports/commission-tiers.ts`) and the
// lock-it-in payout flow (`api/admin/reports/commission-payouts/*`)
// need to sum a designer's net sales over a date range using the
// same matching rules (FK + aliases + the POS-string + split).
// Keeping the logic in one place avoids drift between the two
// surfaces.

import { prisma } from "@/lib/prisma";
import { buildLineItemWhere } from "@/lib/salesBySalesperson";

/**
 * Sum a designer's net sales over `[fromDate, toDateExclusive)`.
 *
 * Matching rules — must mirror designer-dashboard + salesperson-
 * detail so the numbers all agree:
 *   - SalesOrder.salesPersonId = staffId (FK match), OR
 *   - SalesOrder.splitWithId = staffId (split-with FK), OR
 *   - SalesOrder.salesperson matches displayName or any alias
 *     (case-insensitive equals — the POS still imports the string).
 *
 * Status filter: ORDER / FULFILLED / RETURNED (the canonical revenue
 * set). Returns net out as negative line items on RETURNED orders.
 *
 * Line-item filter: `buildLineItemWhere([], false)` excludes cancelled
 * lines + freight/delivery pass-throughs. Same shape used everywhere.
 *
 * Split orders are counted at 0.5× per partner (matches the HR comp
 * report's convention). If a designer is BOTH the primary and the
 * split partner on the same order (impossible in current data but
 * possible in principle), they get 1×.
 */
export async function sumDesignerSales(
  staffId: number,
  matchNames: string[],
  fromDate: Date,
  toDateExclusive: Date,
): Promise<number> {
  const orders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: fromDate, lt: toDateExclusive },
      status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
      OR: [
        ...matchNames.map((name) => ({
          salesperson: { equals: name, mode: "insensitive" as const },
        })),
        { salesPersonId: staffId },
        { splitWithId: staffId },
      ],
    },
    select: {
      splitWithId: true,
      lineItems: {
        where: buildLineItemWhere([], false),
        select: { netPrice: true },
      },
    },
  });

  let total = 0;
  for (const o of orders) {
    const multiplier = o.splitWithId ? 0.5 : 1;
    for (const li of o.lineItems) {
      total += Number(li.netPrice) * multiplier;
    }
  }
  return total;
}
