// /app/src/lib/pricing/pricingUtils.ts
//
// Shared utilities for pricing modules. This file has NO server-only
// dependencies so it can be imported from both server and client code.

/**
 * Parse currency string to number. Handles:
 * "$1,350" → 1350
 * "1350" → 1350
 * "N/A" → NaN
 * "N/C" → NaN
 */
export function parseCurrency(val: string): number {
  if (!val || val === "N/A" || val === "N/C" || val === "-") return NaN;
  return Number.parseFloat(val.replace(/[$,\s]/g, ""));
}
