// /app/src/lib/pricing/pricingUtils.ts
//
// Shared utilities for pricing modules. This file has NO server-only
// dependencies so it can be imported from both server and client code
// (parseBoundary.ts, its one import, has no imports at all).

import { finiteOrNull } from "./parseBoundary";

/**
 * Parse currency string to number. Handles:
 * "$1,350" → 1350
 * "1350" → 1350
 * "N/A" → NaN
 * "N/C" → NaN
 * a number too long to be real (400 digits, "1e999", "Infinity") → NaN
 *
 * NaN is "no price in this cell", and each caller handles it as it handles
 * "N/A". An overflowing value used to read as Infinity, which passed both
 * `isNaN` and `cost > 0`; it now takes the "N/A" path (parseBoundary.ts, rule 42).
 */
export function parseCurrency(val: string): number {
  if (!val || val === "N/A" || val === "N/C" || val === "-") return NaN;
  return finiteOrNull(val.replace(/[$,\s]/g, "")) ?? NaN;
}
