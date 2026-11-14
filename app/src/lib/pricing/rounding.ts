// /app/src/lib/pricing/rounding.ts
//
// How a computed retail price is rounded (GAP-06). The store picks one rule in
// Admin > Settings (AppSettings.pricing.retailRounding) and a mass price change
// can pick another for one run. Each rule is a behaviour compiled here; the
// setting only names one (CLAUDE.md rule 62).
//
// Worked in whole cents, so a price is exact: 0.995 is a cent and a half up, not
// whatever binary floating point makes of it. Only computed prices are rounded --
// a price someone types is theirs. A negative price is refused, never rounded.

export const RETAIL_ROUNDINGS = ["CENTS", "WHOLE_UP", "WHOLE_NEAREST", "END_99", "END_95"] as const;
export type RetailRounding = (typeof RETAIL_ROUNDINGS)[number];

/** The default invents nothing: the computed price to the nearest cent. */
export const DEFAULT_RETAIL_ROUNDING: RetailRounding = "CENTS";

export const RETAIL_ROUNDING_LABELS: Record<RetailRounding, string> = {
  CENTS: "To the cent (no rounding)",
  WHOLE_UP: "Up to the next whole dollar",
  WHOLE_NEAREST: "To the nearest whole dollar",
  END_99: "Just under the nearest whole dollar (.99)",
  END_95: "Just under the nearest whole dollar (.95)",
};

export function isRetailRounding(value: unknown): value is RetailRounding {
  return typeof value === "string" && (RETAIL_ROUNDINGS as readonly string[]).includes(value);
}

/**
 * A non-negative amount in whole cents, rounded half up. Read from the number's
 * decimal text rather than multiplied by 100: 1.005 * 100 is 100.49999... in
 * floating point, and 1.005 is a cent and a half.
 */
export function toCents(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`A price must be a number of zero or more, not ${value}`);
  }
  const [whole, fraction] = value.toFixed(6).split(".");
  const cents = Number(whole) * 100 + Number(fraction.slice(0, 2));
  return Number(fraction.slice(2)) >= 5000 ? cents + 1 : cents;
}

/** The price `value` becomes under `rule`, in dollars to the cent. */
export function roundRetail(value: number, rule: RetailRounding): number {
  const cents = toCents(value);
  switch (rule) {
    case "CENTS":
      return cents / 100;
    case "WHOLE_UP":
      return Math.ceil(cents / 100);
    case "WHOLE_NEAREST":
      return Math.floor((cents + 50) / 100);
    case "END_99":
      return justUnderNearestDollar(cents, 1) / 100;
    case "END_95":
      return justUnderNearestDollar(cents, 5) / 100;
  }
}

/**
 * Charm pricing as stores use it (owner, 2026-11-14: "100 should be 99.99 not
 * 100.99"): round to the nearest whole dollar, then take `under` cents off, so
 * the left digit drops. 100.00 -> 99.99, 101.40 -> 100.99, 101.60 -> 101.99.
 * A price that rounds to $0 stays $0 (no price), never a negative one; the
 * mass change then skips it as "would round to no price".
 */
function justUnderNearestDollar(cents: number, under: number): number {
  const dollars = Math.floor((cents + 50) / 100);
  return dollars === 0 ? 0 : dollars * 100 - under;
}
