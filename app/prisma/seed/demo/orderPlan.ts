// app/prisma/seed/demo/orderPlan.ts
//
// Pure (no DB) construction of the order schedule: which day each order
// falls on (seasonality-weighted), its store/register/designer, its
// customer, its line-item split (from the calibrated order-value
// distribution), its tender, and whether it carries a same-day refund.
// Kept separate from salesOrders.ts so the shaped-randomness is easy to
// read/adjust without wading through Prisma calls.

import type { Rng } from "./rng";
import {
  chance,
  pick,
  randInt,
  round2,
  sampleLineItemCount,
  sampleOrderValue,
  splitAmount,
  subRng,
  weightedPick,
} from "./rng";
import { MONTHLY_SEASONALITY, PAYMENT_METHOD_MIX } from "./config";
import type { CatalogProduct } from "./catalog";
import type { SeededCustomer } from "./customers";
import type { SeededStaffMember, StaffSetup } from "./staff";

export type PaymentMethodTender = "CARD" | "CASH" | "GIFT_CARD" | "STORE_CREDIT";

export interface OrderLinePlan {
  productId: number;
  quantity: number;
  netPrice: number;
  cost: number;
  vatAmount: number;
}

export interface OrderPlan {
  index: number;
  orderno: string;
  date: Date;
  storeId: number;
  registerId: number;
  designer: SeededStaffMember;
  customerId: number | null;
  isTaxExempt: boolean;
  isInvoiced: boolean;
  lines: OrderLinePlan[];
  method: PaymentMethodTender;
  hasRefund: boolean;
  refundLineIndex: number;
}

export interface StoreForPlan {
  id: number;
  registerIds: number[];
}

const TAX_RATE = 0.0635;
/** Fraction of orders that get same-day revenue recognition (an Invoice
 * row) instead of booking as a pure deposit. See docs/domains/seed-data.md
 * "Invoiced vs deposit-only orders" for why this split exists at all. */
const INVOICED_SHARE = 0.7;
/**
 * Refunds are only modeled on invoiced orders (see salesOrders.ts for why:
 * an un-invoiced order's line items never reach buildJournalLines, so a
 * mirrored negative line there would be inert). Solved so that
 * INVOICED_SHARE * REFUND_PROBABILITY_GIVEN_INVOICED ≈ the refund share of
 * ALL orders needed to land refund ROWS at REFUND_SHARE_OF_ALL_PAYMENTS of
 * all payment rows once refund rows are added on top of one row per order:
 * 0.70 * 0.0911 ≈ 0.0638; 0.0638 / 1.0638 ≈ 0.060 (config.ts's 6%).
 */
const REFUND_PROBABILITY_GIVEN_INVOICED = 0.0911;
/** Most tickets in a considered-purchase furniture store capture a real
 * customer record; a minority are anonymous counter sales. */
const CUSTOMER_ASSIGNMENT_PROBABILITY = 0.9;

export function buildOrderPlans(
  rng: Rng,
  window: { start: Date; end: Date },
  orderCount: number,
  stores: readonly StoreForPlan[],
  staff: StaffSetup,
  customers: readonly SeededCustomer[],
  products: readonly CatalogProduct[],
  orderNumberStart: number,
): OrderPlan[] {
  const dateRng = subRng(rng, "order-dates");
  const detailRng = subRng(rng, "order-details");

  const months = enumerateMonths(window.start, window.end);
  const totalWeight = months.reduce((s, m) => s + MONTHLY_SEASONALITY[m.month], 0);
  const monthCounts = months.map((m) =>
    Math.round((orderCount * MONTHLY_SEASONALITY[m.month]) / totalWeight),
  );
  let drift = orderCount - monthCounts.reduce((a, b) => a + b, 0);
  const byVolumeDesc = [...monthCounts.keys()].sort((a, b) => monthCounts[b] - monthCounts[a]);
  let cursor = 0;
  while (drift !== 0) {
    const idx = byVolumeDesc[cursor % byVolumeDesc.length];
    monthCounts[idx] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
    cursor += 1;
  }

  const dates: Date[] = [];
  for (const [i, m] of months.entries()) {
    const count = monthCounts[i];
    const daysInMonth = new Date(Date.UTC(m.year, m.month + 1, 0)).getUTCDate();
    // Clamp the boundary months so no order lands before window.start or
    // after window.end -- without this, the first/last calendar month
    // generates days across its FULL 1..daysInMonth range regardless of
    // where the window actually begins/ends (e.g. an 18-month window
    // ending mid-month would otherwise seed orders "in the future" past
    // the as-of anchor date, in the final month).
    const minDay = i === 0 ? window.start.getUTCDate() : 1;
    const maxDay = i === months.length - 1 ? window.end.getUTCDate() : daysInMonth;
    for (let k = 0; k < count; k++) {
      const day = randInt(dateRng, minDay, Math.max(minDay, maxDay));
      const hour = randInt(dateRng, 10, 18);
      const minute = randInt(dateRng, 0, 59);
      dates.push(new Date(Date.UTC(m.year, m.month, day, hour, minute)));
    }
  }
  dates.sort((a, b) => a.getTime() - b.getTime());

  const plans: OrderPlan[] = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const storeWeights = stores.map((s, si) => [s, si === 0 ? 55 : 45] as const);
    const store = weightedPick(detailRng, storeWeights);
    const registerId = pick(detailRng, store.registerIds);

    const homeDesigners = staff.designers.filter((d) => d.homeStoreId === store.id);
    const pool = homeDesigners.length > 0 ? homeDesigners : staff.designers;
    const designerWeights: [SeededStaffMember, number][] = staff.designers.map((d) => [
      d,
      pool.includes(d) ? 3 : 1,
    ]);
    const designer = weightedPick(detailRng, designerWeights);

    const hasCustomer = chance(detailRng, CUSTOMER_ASSIGNMENT_PROBABILITY);
    const customer = hasCustomer ? pick(detailRng, customers) : null;
    const isTaxExempt = customer?.taxExempt ?? false;

    const isInvoiced = chance(detailRng, INVOICED_SHARE);

    let method = weightedPick(
      detailRng,
      PAYMENT_METHOD_MIX.map(([m, w]) => [m as PaymentMethodTender, w] as const),
    );
    if (method === "STORE_CREDIT" && !customer) method = "CARD";

    const hasRefund = isInvoiced && chance(detailRng, REFUND_PROBABILITY_GIVEN_INVOICED);

    const total = sampleOrderValue(detailRng);
    const lineCount = sampleLineItemCount(detailRng);
    const shares = splitAmount(detailRng, total, lineCount);

    const lines: OrderLinePlan[] = shares.map((share) => {
      const product = pick(detailRng, products);
      const vatAmount = isTaxExempt ? 0 : round2(share * TAX_RATE);
      const costRatio = randInt(detailRng, 35, 58) / 100;
      const cost = round2(share * costRatio);
      return { productId: product.id, quantity: 1, netPrice: share, cost, vatAmount };
    });

    plans.push({
      index: i,
      orderno: `SO-${orderNumberStart + i}`,
      date,
      storeId: store.id,
      registerId,
      designer,
      customerId: customer?.id ?? null,
      isTaxExempt,
      isInvoiced,
      lines,
      method,
      hasRefund,
      refundLineIndex: randInt(detailRng, 0, lines.length - 1),
    });
  }

  return plans;
}

function enumerateMonths(start: Date, end: Date): { year: number; month: number }[] {
  const months: { year: number; month: number }[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endCursor.getTime()) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
