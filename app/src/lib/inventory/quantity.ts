// /app/src/lib/inventory/quantity.ts
//
// Stock quantities are fractional, because a roll of fabric or wallpaper is a
// length rather than a count. This file owns the arithmetic so the rounding
// rule lives in exactly one place.
//
// Deliberately NOT lib/journalEntry.ts's round2(). That one is money: two
// decimal places, because a cent is the smallest thing you can owe. A quantity
// is not money and does not round like it -- fabric is sold to the eighth of a
// yard, so 0.125 has to survive a round trip, and 2dp would turn it into 0.13
// and lose an eighth on every line.

import { Prisma } from "@prisma/client";

/** Places kept on a stock quantity. Matches `@db.Decimal(12, 3)` in the schema. */
export const QTY_DP = 3;

const FACTOR = 10 ** QTY_DP;

/**
 * Anything smaller than this is rounding noise, not stock.
 *
 * Used instead of `===` when asking "did this draw take the whole position?".
 * Exact equality on floats is how a position ends up stranded at 0.0000001 and
 * never gets cleaned up -- present in every count, sellable to nobody.
 */
export const QTY_EPSILON = 1 / (FACTOR * 2);

/** Prisma Decimal (or a plain number, or null) -> number. */
export function toQty(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === "number" ? value : value.toNumber();
}

/** Round to the stock precision. */
export function roundQty(n: number): number {
  return Math.round(n * FACTOR) / FACTOR;
}

/** True when two quantities are the same to within rounding noise. */
export function qtyEquals(a: number, b: number): boolean {
  return Math.abs(a - b) < QTY_EPSILON;
}

/** True when a quantity is effectively zero -- nothing left to sell or move. */
export function qtyIsZero(n: number): boolean {
  return Math.abs(n) < QTY_EPSILON;
}

/** A number on its way back into a Decimal column. */
export function toDecimal(n: number): Prisma.Decimal {
  return new Prisma.Decimal(roundQty(n).toFixed(QTY_DP));
}
