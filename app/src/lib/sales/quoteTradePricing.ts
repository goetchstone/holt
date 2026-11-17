// /app/src/lib/sales/quoteTradePricing.ts
//
// GAP-06 part C: a quote whose customer changes is priced as that customer's
// sale, beside the tax it is re-rated for (lib/tax/rerateQuoteTax.ts). The new
// customer's trade tier applies to the quote's eligible lines, and a tier the
// old customer had comes off.
//
// Only a line still at the price it was written at -- its list price, or the
// trade price it recorded -- is re-priced. A line someone typed a price on, or
// discounted, keeps its price and is counted as kept. The list price stays what
// the line recorded (no retail is re-read), so changing the customer moves
// only the tier, and whether the tier may come off a sale price is asked of
// the sale flag the line recorded with its list (OrderLineItem.listOnSale).
// The caller re-prices only a quote no money has touched, the
// same rule as the tax (orders/[id].ts).
//
// A kept line is still judged for its new customer. Its discount was measured
// from the old customer's trade price; when the new customer's price for it is
// higher (a trade quote handed to a walk-in), what it now sells below is a
// discount the new customer was never given, and the caller authorizes it as
// any other (planQuoteTrade's `percent`, authorizeDiscount -- a manager's PIN
// past the store's limit). Every line, kept or re-priced, records the new
// customer's tier or none, never the old one's, so a later edit measures from
// the right price.
//
// Each re-priced line is written to the order's history, as a price edit is.

import type { PrismaTx } from "@/lib/inventory/allocation";
import { toCents } from "@/lib/pricing/rounding";
import { COUNTED_ITEM_LINE } from "@/lib/salesOrderRevenue";
import {
  type Approver,
  currentLinePolicies,
  existingLinePolicy,
  logDiscountApproval,
  recordedTrade,
  tradePolicies,
} from "@/lib/sales/discountApproval";
import { lineDiscountPercent } from "@/lib/sales/discountPolicyShared";

const cents = (n: number): number => toCents(n) / 100;

export interface QuoteTradeRepricing {
  /** Lines moved to the new customer's price. */
  repriced: number;
  /** Lines left at a price someone typed or discounted. */
  kept: number;
}

interface PlannedLine {
  id: number;
  /** What the line sold for before. */
  previousNet: number;
  /** What it sells for now: the new customer's price, or the price someone set. */
  netPrice: number;
  /** The tier it records for the new customer, or none. */
  trade: { tradeTierId: number | null; tradeDiscountPercent: number | null };
  /** Whether anything about the line changes. */
  changed: boolean;
  /** Moved to the new customer's price. */
  repriced: boolean;
  /** Left at a price someone typed or discounted. */
  kept: boolean;
  /** A kept line's discount, measured from the new customer's price, when that is higher than the old one's. */
  percent: number;
}

export interface QuoteTradePlan {
  lines: PlannedLine[];
  /** The deepest discount a kept line now gives the new customer: what to authorize. */
  percent: number;
}

/**
 * What handing a quote from `fromCustomerId` to `toCustomerId` does to its
 * prices. Read-only: run before the change's transaction to authorize its
 * `percent` (a wrong PIN must still count), and again inside it to apply.
 */
export async function planQuoteTrade(
  db: PrismaTx,
  orderId: number,
  fromCustomerId: number | null,
  toCustomerId: number | null,
): Promise<QuoteTradePlan> {
  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      deliveryFeeLineItemId: true,
      // Items sold on the quote: not cancelled (rule 33), more than nothing
      // (rule 31) and not given back, with a catalog product and a list price.
      lineItems: {
        where: {
          ...COUNTED_ITEM_LINE,
          productId: { not: null },
          listPrice: { not: null },
          orderedQuantity: { gt: 0 },
        },
        select: {
          id: true,
          productId: true,
          orderedQuantity: true,
          netPrice: true,
          listPrice: true,
          listOnSale: true,
          tradeTierId: true,
          tradeDiscountPercent: true,
        },
      },
    },
  });
  const lines = order.lineItems.filter((l) => l.id !== order.deliveryFeeLineItemId);
  if (lines.length === 0) return { lines: [], percent: 0 };

  // What each line was measured from under the customer it is leaving, and
  // what the new customer's tier makes of the list price it recorded -- with
  // the sale flag recorded beside that list, not whether a sale is on today: a
  // quote written at a sale price stays a sale-price list after the sale ends,
  // and one written at the regular price is not a sale price because a sale
  // started since.
  const before = await currentLinePolicies(db, lines, fromCustomerId);
  const after = await tradePolicies(
    db,
    lines.map((l) => ({
      productId: l.productId as number,
      listUnit: Number(l.listPrice),
      onSale: l.listOnSale,
    })),
    toCustomerId,
  );

  const planned = lines.map((line, i): PlannedLine => {
    const qty = Number(line.orderedQuantity);
    const previousNet = Number(line.netPrice);
    // Untouched: it sells for exactly its baseline as written -- its list, or
    // the trade price it recorded.
    const was = existingLinePolicy(line).baselineUnit;
    const untouched = Math.abs(previousNet - cents(was * qty)) <= 0.005;
    const netPrice = untouched ? cents(after[i].baselineUnit * qty) : previousNet;
    const trade = recordedTrade(after[i], { quantity: qty, netPrice });
    const recorded = line.tradeDiscountPercent == null ? null : Number(line.tradeDiscountPercent);
    const changed =
      Math.abs(netPrice - previousNet) > 0.005 ||
      trade.tradeTierId !== line.tradeTierId ||
      trade.tradeDiscountPercent !== recorded;
    const rises = after[i].baselineUnit > before[i].baselineUnit + 0.005;
    const percent =
      untouched || !rises
        ? 0
        : lineDiscountPercent({ listUnit: after[i].baselineUnit, quantity: qty, netPrice });
    return {
      id: line.id,
      previousNet,
      netPrice,
      trade,
      changed,
      repriced: untouched && Math.abs(netPrice - previousNet) > 0.005,
      kept: !untouched,
      percent,
    };
  });
  return {
    lines: planned,
    percent: planned.reduce((max, l) => Math.max(max, l.percent), 0),
  };
}

/**
 * Apply a quote's change of customer to its prices, inside the change's
 * transaction (the order already names its new customer). `approver` is the
 * manager who approved the plan's `percent`, when one had to.
 */
export async function repriceQuoteTrade(
  tx: PrismaTx,
  orderId: number,
  input: { fromCustomerId: number | null; changedBy: string | null; approver: Approver | null },
): Promise<QuoteTradeRepricing> {
  const { customerId } = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { customerId: true },
  });
  const plan = await planQuoteTrade(tx, orderId, input.fromCustomerId, customerId);

  let repriced = 0;
  for (const line of plan.lines) {
    if (line.changed) {
      await tx.orderLineItem.update({
        where: { id: line.id },
        data: { netPrice: line.netPrice, ...line.trade },
      });
    }
    if (line.repriced) {
      await tx.orderChangeLog.create({
        data: {
          salesOrderId: orderId,
          lineItemId: line.id,
          changeType: "PRICE_CHANGE",
          previousValue: `net: ${line.previousNet}`,
          newValue: `net: ${line.netPrice}`,
          reason: line.trade.tradeDiscountPercent
            ? `Customer changed: trade price (${line.trade.tradeDiscountPercent}% off)`
            : "Customer changed: list price",
          changedBy: input.changedBy,
        },
      });
      repriced += 1;
    }
    if (input.approver && line.percent > 0) {
      await logDiscountApproval(tx, {
        orderId,
        lineItemId: line.id,
        approver: input.approver,
        percent: line.percent,
        changedBy: input.changedBy,
      });
    }
  }
  return { repriced, kept: plan.lines.filter((l) => l.kept).length };
}
