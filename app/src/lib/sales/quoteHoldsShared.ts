// /app/src/lib/sales/quoteHoldsShared.ts
//
// GAP-16: a quote can hold floor stock for its customer until a date. Shared by
// the screens, which offer the dates a store allows, and the server
// (lib/sales/quoteHolds.ts and lib/inventory/orderInventorySync.ts), which
// decides what a sale commits. Client-safe: no Prisma here.
//
// What a sale commits (owner, 2026-11-01: "we can put it on a quote and part of
// the quote if it is floor stock can be hold until x date, and again a config
// would set the max allowed"):
//   - An order commits every stocked line, as it always has.
//   - A quote commits only the lines it holds, and only through the hold's last
//     day. A line with no hold, or one whose day has passed, commits nothing,
//     so a quote nobody came back for no longer keeps a sofa off the floor.
//   - The store sets the longest hold (AppSettings.quoteHoldMaxDays); 0 means
//     quotes hold nothing.
//
// A hold is a calendar day in the store's own time zone (AppSettings.timezone;
// today is businessDayKey, lib/reports/businessDay.ts), stored in a DATE
// column: "held until Saturday" means through Saturday, not until midnight UTC.

import { addDays, isDayKey } from "@/lib/reports/businessDay";

/** What the screens need to offer a hold: GET /api/sales/quote-hold-policy. */
export interface QuoteHoldPolicy {
  /** Today on the store's clock, "YYYY-MM-DD". */
  today: string;
  /** The store's longest hold, in days; 0 = quotes hold nothing. */
  maxDays: number;
  /** The last day a hold set today may run to; null when the store holds nothing. */
  latest: string | null;
}

/** The most a store may set: a year. */
export const QUOTE_HOLD_MAX_DAYS_LIMIT = 365;
/** The shipped default, the strict end: a long weekend. */
export const QUOTE_HOLD_DEFAULT_MAX_DAYS = 3;

export const QUOTE_HOLD_RULE = `a whole number of days from 0 (quotes hold nothing) to ${QUOTE_HOLD_MAX_DAYS_LIMIT}`;

export function isQuoteHoldMaxDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= QUOTE_HOLD_MAX_DAYS_LIMIT
  );
}

/** The last day a hold set today may run to, or null when the store holds nothing. */
export function latestHoldDate(today: string, maxDays: number): string | null {
  return maxDays > 0 ? addDays(today, maxDays) : null;
}

/** The value a DATE column stores for a calendar day. */
export function holdDateValue(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** A DATE column's value (or its JSON) as "YYYY-MM-DD". */
export function holdDateString(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

/** Why a hold can't end on `holdUntil`, or null when it can. */
export function holdDateProblem(
  holdUntil: unknown,
  ctx: { today: string; maxDays: number },
): string | null {
  const latest = latestHoldDate(ctx.today, ctx.maxDays);
  if (latest == null) return "This store's quotes don't hold stock (Settings › Sales).";
  if (!isDayKey(holdUntil)) return "holdUntil must be a date (YYYY-MM-DD).";
  if (holdUntil < ctx.today) return "A hold can't end before today.";
  if (holdUntil > latest) {
    const days = ctx.maxDays === 1 ? "1 day" : `${ctx.maxDays} days`;
    return `A quote may hold stock for at most ${days}: until ${latest}.`;
  }
  return null;
}

/** The hold still runs today: its last day is today or later. */
export function holdIsOpen(holdUntil: Date | string | null | undefined, today: string): boolean {
  return holdUntil != null && holdDateString(holdUntil) >= today;
}

/** Does this line commit stock? Every line of an order; on a quote, only one held today. */
export function lineCommitsStock(args: {
  orderStatus: string;
  holdUntil: Date | string | null | undefined;
  today: string;
}): boolean {
  return args.orderStatus !== "QUOTE" || holdIsOpen(args.holdUntil, args.today);
}

/** Why this quote line can't hold stock, or null when it can. */
export function lineHoldProblem(line: {
  lineItemStatus: string;
  source: string | null;
  /** Null when the line has no product. */
  stocked: boolean | null;
}): string | null {
  if (line.lineItemStatus !== "ACTIVE") return "Only an active line can be held.";
  if (line.source === "ORDER")
    return "A special-order line isn't floor stock, so it can't be held.";
  if (!line.stocked) return "Only floor stock can be held, and this line has no stocked product.";
  return null;
}

/** Days from today to a hold's last day: 0 on its last day. */
export function holdDaysLeft(holdUntil: Date | string, today: string): number {
  const end = Date.parse(`${holdDateString(holdUntil)}T00:00:00.000Z`);
  const start = Date.parse(`${today}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}
