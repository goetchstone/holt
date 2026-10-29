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
import { businessDayKey, businessDayStart, sameDateLastYear } from "@/lib/reports/businessDay";
import {
  MONTHLY_SEASONALITY,
  PAYMENT_METHOD_MIX,
  SEED_TAX_RATE,
  SEED_TIME_ZONE,
  STORE_LAST_SALE_HOUR,
  STORE_OPEN_HOUR,
} from "./config";
import { UNKNOWN_VENDOR_ACTUAL_LEAD_DAYS, type CatalogProduct } from "./catalog";
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

/**
 * Where a DELIVERY order stands on the as-of day.
 *
 * Taken (floor) sales leave with the customer and are FULFILLED on the day.
 * A delivery order waits for its goods -- the slowest vendor's lead time on the
 * order -- then to be booked, then for a delivery day. Everything that should
 * have arrived and gone out by now has; what is still open is recent, so an open
 * order from last spring cannot exist the way it did when the state was drawn
 * at random.
 */
export type DispatchPlan =
  "FULFILLED" | "PO_PLACED" | "RECEIVED_IN_WAREHOUSE" | "SCHEDULED_DELIVERY" | "READY_FOR_PICKUP";

export interface OrderPlan {
  index: number;
  orderno: string;
  date: Date;
  /** The business day `date` falls on, in the demo's timezone. */
  dayKey: string;
  storeId: number;
  storeName: string;
  registerId: number;
  designer: SeededStaffMember;
  customerId: number | null;
  isTaxExempt: boolean;
  /** Written on the order, as the register does, so Tax Summary files it. */
  taxExemptReasonId: number | null;
  isInvoiced: boolean;
  lines: OrderLinePlan[];
  method: PaymentMethodTender;
  hasRefund: boolean;
  refundLineIndex: number;
  /** When the order was handed over: the sale itself for a floor sale, the
   *  delivery day for a delivery order that has gone out, else null. */
  deliveredAt: Date | null;
  dispatch: DispatchPlan;
}

export interface StoreForPlan {
  id: number;
  name: string;
  registerIds: number[];
}

/**
 * Orders guaranteed on the as-of day and on the same date last year. The
 * dashboard's store cards compare exactly those two days, and at the small
 * "ci" volume (well under one order a day) either could otherwise be empty.
 */
const DASHBOARD_DAY_MIN_ORDERS = 8;

/** A vendor that runs late: how often, and by how much. */
const VENDOR_LATE_SHARE = 0.15;
const VENDOR_LATE_DAYS: [number, number] = [5, 30];

/** Delivery goes out Tuesday to Saturday (UTC getUTCDay of a local noon). */
const DELIVERY_WEEKDAYS = new Set([2, 3, 4, 5, 6]);

/** `hour:minute` local time on business day `dayKey`, as an instant. */
function localTime(dayKey: string, hour: number, minute: number): Date {
  return new Date(
    businessDayStart(dayKey, SEED_TIME_ZONE).getTime() + (hour * 60 + minute) * 60_000,
  );
}

function addDaysKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The first delivery day on or after `dayKey`. */
function nextDeliveryDay(dayKey: string): string {
  let key = dayKey;
  for (let i = 0; i < 7; i++) {
    const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (DELIVERY_WEEKDAYS.has(weekday)) return key;
    key = addDaysKey(key, 1);
  }
  return key;
}

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
/**
 * How far through the history the departed designers were still selling, and
 * what share of orders they took while there. 0.45 x 0.12 ≈ 5% of all orders
 * -- enough history for the departed-staff paths to have something to show.
 */
const DEPARTED_ACTIVE_UNTIL = 0.45;
const DEPARTED_SHARE_WHILE_ACTIVE = 0.12;

/**
 * Share of orders written by non-designer floor staff.
 *
 * 22% keeps non-designer sellers a visible, non-trivial share. It matters that
 * this is not zero: a seed where only designers sell reproduces the exact
 * assumption that left those sellers without staff records, and nothing
 * downstream would notice a report that silently drops them.
 */
const FLOOR_SELLER_SHARE = 0.22;

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
      const hour = randInt(dateRng, STORE_OPEN_HOUR, STORE_LAST_SALE_HOUR);
      const minute = randInt(dateRng, 0, 59);
      const dayKey = `${m.year}-${String(m.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      // Showroom hours in the business's own timezone. These were 10:00-18:59
      // UTC, which is 6am-3pm in New York: a dashboard reading "today" in the
      // business timezone saw a day of sales that ended mid-afternoon.
      dates.push(localTime(dayKey, hour, minute));
    }
  }

  // The dashboard compares today with the same date last year. Make sure both
  // days have a believable handful of sales, whatever the volume preset.
  const asOfKey = window.end.toISOString().slice(0, 10);
  const startKey = window.start.toISOString().slice(0, 10);
  for (const key of [asOfKey, sameDateLastYear(asOfKey)]) {
    if (key < startKey) continue;
    const have = dates.filter((d) => businessDayKey(d, SEED_TIME_ZONE) === key).length;
    for (let k = have; k < DASHBOARD_DAY_MIN_ORDERS; k++) {
      const hour = randInt(dateRng, STORE_OPEN_HOUR, STORE_LAST_SALE_HOUR);
      dates.push(localTime(key, hour, randInt(dateRng, 0, 59)));
    }
  }
  dates.sort((a, b) => a.getTime() - b.getTime());

  const productById = new Map(products.map((p) => [p.id, p]));
  const fulfilRng = subRng(rng, "order-fulfilment");

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
    // A share of the OLDER history belongs to designers who have since left.
    // Real deployments always carry archived staff who still hold historical
    // sales. Without it nothing exercises a departed designer keeping their
    // historical attribution and commission history while being absent from
    // every current-staff picker.
    //
    // They stop appearing partway through the range because that is what
    // leaving means -- a departed designer with orders last week would be a
    // worse fixture than none at all.
    const historyPosition = dates.length > 1 ? i / (dates.length - 1) : 1;
    const departedPool = staff.departedDesigners;
    const attributeToDeparted =
      departedPool.length > 0 &&
      historyPosition < DEPARTED_ACTIVE_UNTIL &&
      chance(detailRng, DEPARTED_SHARE_WHILE_ACTIVE);

    // Non-designer floor staff take their share first: they are a different kind
    // of seller, not a designer variant, so they are picked before the designer
    // weighting rather than folded into it.
    // Archived floor staff obey the same rule as archived designers: they stop
    // selling partway through the window. Leaving them in the whole range put a
    // departed seller's last order on the final day of history.
    const floorPool = staff.floorSellers.filter(
      (f) => f.isActive || historyPosition < DEPARTED_ACTIVE_UNTIL,
    );
    const attributeToFloor =
      !attributeToDeparted && floorPool.length > 0 && chance(detailRng, FLOOR_SELLER_SHARE);

    const designer = attributeToDeparted
      ? pick(detailRng, departedPool)
      : attributeToFloor
        ? pick(detailRng, floorPool)
        : weightedPick(detailRng, designerWeights);

    const hasCustomer = chance(detailRng, CUSTOMER_ASSIGNMENT_PROBABILITY);
    const customer = hasCustomer ? pick(detailRng, customers) : null;
    const taxExemptReasonId = customer?.taxExemptReasonId ?? null;
    const isTaxExempt = taxExemptReasonId != null;

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
      const vatAmount = isTaxExempt ? 0 : round2(share * SEED_TAX_RATE);
      const costRatio = randInt(detailRng, 35, 58) / 100;
      const cost = round2(share * costRatio);
      return { productId: product.id, quantity: 1, netPrice: share, cost, vatAmount };
    });

    const dayKey = businessDayKey(date, SEED_TIME_ZONE);
    const fulfilment = isInvoiced
      ? { deliveredAt: date, dispatch: "FULFILLED" as const }
      : planDelivery(fulfilRng, date, dayKey, lines, productById, asOfKey);

    plans.push({
      index: i,
      orderno: `SO-${orderNumberStart + i}`,
      date,
      dayKey,
      storeId: store.id,
      storeName: store.name,
      registerId,
      designer,
      customerId: customer?.id ?? null,
      isTaxExempt,
      taxExemptReasonId,
      isInvoiced,
      lines,
      method,
      hasRefund,
      refundLineIndex: randInt(detailRng, 0, lines.length - 1),
      deliveredAt: fulfilment.deliveredAt,
      dispatch: fulfilment.dispatch,
    });
  }

  return plans;
}

/**
 * When a delivery order's goods arrive and it goes out, against the as-of day.
 *
 * Goods arrive after the slowest vendor's standard lead time on the order; one
 * order in seven is late by up to a month, the way some vendors are. The
 * customer is booked a few days after the goods land, for a delivery day a week
 * or two out. Anything whose delivery day is before today was delivered;
 * anything still open is recent by construction.
 */
function planDelivery(
  rng: Rng,
  date: Date,
  dayKey: string,
  lines: readonly OrderLinePlan[],
  productById: ReadonlyMap<number, CatalogProduct>,
  asOfKey: string,
): { deliveredAt: Date | null; dispatch: DispatchPlan } {
  const leadDays = Math.max(
    ...lines.map(
      (l) => productById.get(l.productId)?.vendorLeadTimeDays ?? UNKNOWN_VENDOR_ACTUAL_LEAD_DAYS,
    ),
  );
  const slipDays = chance(rng, VENDOR_LATE_SHARE)
    ? randInt(rng, VENDOR_LATE_DAYS[0], VENDOR_LATE_DAYS[1])
    : randInt(rng, -4, 2);
  const arrivalKey = addDaysKey(dayKey, leadDays + slipDays);
  // Arrived goods wait a few days for the customer to be called and a date
  // agreed; the delivery itself is booked a week or two out, on a delivery day.
  const bookedKey = addDaysKey(arrivalKey, randInt(rng, 1, 5));
  const deliveryKey = nextDeliveryDay(addDaysKey(bookedKey, randInt(rng, 3, 10)));

  if (deliveryKey < asOfKey) {
    const hour = randInt(rng, 9, 16);
    return {
      deliveredAt: localTime(deliveryKey, hour, randInt(rng, 0, 59)),
      dispatch: "FULFILLED",
    };
  }
  if (arrivalKey > asOfKey) return { deliveredAt: null, dispatch: "PO_PLACED" };
  // In the warehouse: not yet booked (the queue the Ready to Deliver board
  // schedules from), booked onto a run, or waiting for the customer to collect.
  if (bookedKey > asOfKey) return { deliveredAt: null, dispatch: "RECEIVED_IN_WAREHOUSE" };
  if (chance(rng, 0.12)) return { deliveredAt: null, dispatch: "READY_FOR_PICKUP" };
  return { deliveredAt: null, dispatch: "SCHEDULED_DELIVERY" };
}

/** Shared with the other seed modules that put things on a business day. */
export { addDaysKey, localTime };

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
