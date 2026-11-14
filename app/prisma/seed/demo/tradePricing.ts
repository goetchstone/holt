// /app/prisma/seed/demo/tradePricing.ts
//
// GAP-06 part C: trade tier pricing. A handful of the demo's trade customers
// are given a tier, and two of them have a quote priced at their tier.
//
// Through the code staff use: the tier is given by the one writer of it
// (lib/customers/tradeTierAssignment.ts), so each assignment has its
// TRADE_TIER_ASSIGNED audit entry as one from the customer screen does, and the
// quotes are copies of an earlier sale made by Duplicate order
// (lib/sales/duplicateOrder.ts), which prices each line at today's price under
// the customer's tier and records the tier on the line (the discount policy's
// catalogLinePolicies). No RNG draws: customers and orders are taken in id
// order, and this runs last, so nothing else the seed makes shifts.

import type { PrismaClient } from "@prisma/client";
import { setCustomerTradeTier } from "@/lib/customers/tradeTierAssignment";
import { duplicateOrder } from "@/lib/sales/duplicateOrder";
import { getAppSettings } from "@/lib/appSettings";

const SEED_ACTOR = "seed:demo";
/** Trade customers given a tier. */
const TIERED_CUSTOMERS = 5;
/** Of those, how many get a quote at their tier. */
const TIER_PRICED_QUOTES = 2;

export async function seedTradePricing(
  prisma: PrismaClient,
  now: Date,
): Promise<{ tiered: number; quotes: number; tierPricedLines: number }> {
  const tiers = await prisma.tradeTier.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (tiers.length === 0) throw new Error("Trade pricing seed: no active trade tier to give.");

  // Trade customers with a sale of catalog items come first: a copy of that
  // sale is their tier-priced quote.
  const sales = await prisma.salesOrder.findMany({
    where: {
      customer: { isTradeAccount: true },
      returnFor: { is: null },
      lineItems: {
        some: {
          lineItemStatus: "ACTIVE",
          giftCardNumber: null,
          orderedQuantity: { gt: 0 },
          product: { madeToOrder: false, vendor: { allowTradeDiscount: true } },
        },
      },
    },
    orderBy: { id: "asc" },
    select: { id: true, customerId: true },
  });
  const toCopy: { orderId: number; customerId: number }[] = [];
  for (const sale of sales) {
    if (sale.customerId == null || toCopy.some((c) => c.customerId === sale.customerId)) continue;
    toCopy.push({ orderId: sale.id, customerId: sale.customerId });
    if (toCopy.length === TIER_PRICED_QUOTES) break;
  }
  const others = await prisma.customer.findMany({
    where: { isTradeAccount: true, id: { notIn: toCopy.map((c) => c.customerId) } },
    orderBy: { id: "asc" },
    take: TIERED_CUSTOMERS - toCopy.length,
    select: { id: true },
  });
  const customerIds = [...toCopy.map((c) => c.customerId), ...others.map((c) => c.id)];

  const settings = await getAppSettings();
  return prisma.$transaction(async (tx) => {
    for (const [i, customerId] of customerIds.entries()) {
      await setCustomerTradeTier(tx, {
        customerId,
        tradeTierId: tiers[i % tiers.length].id,
        actor: SEED_ACTOR,
      });
    }
    const copies = [];
    for (const { orderId } of toCopy) {
      copies.push(
        await duplicateOrder(tx, {
          orderId,
          actor: { email: SEED_ACTOR, displayName: null },
          settings,
          now,
        }),
      );
    }
    const tierPricedLines = await tx.orderLineItem.count({
      where: { salesOrderId: { in: copies.map((c) => c.id) }, tradeDiscountPercent: { not: null } },
    });
    // A seed that gave tiers and priced nothing at them has lost the feature.
    if (copies.length > 0 && tierPricedLines === 0) {
      throw new Error("Trade pricing seed: the tier-priced quotes carry no tier-priced line.");
    }
    return { tiered: customerIds.length, quotes: copies.length, tierPricedLines };
  });
}
