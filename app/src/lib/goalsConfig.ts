// /app/src/lib/goalsConfig.ts
//
// Shared client/server contract for salesperson goal configuration.
// Imported by both the goals admin page (client) and the monthly
// performance report API (server), so it must stay free of server-only
// imports (no prisma, no fs).
//
// A yearly goal is allocated across the twelve months using a weight
// vector that sums to 1.0. By default the allocation is even (each month
// gets 1/12 of the yearly goal). A business with seasonal sales can store
// a custom 12-element weight vector per salesperson on
// `SalesGoal.monthlyWeights`; `resolveMonthlyWeights` falls back to even
// weights when none is configured.

export const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Default percentage of sales over the monthly goal paid out as bonus. */
export const DEFAULT_BONUS_RATE = 0.06;

/** Even allocation — each of the twelve months gets 1/12 of the yearly goal. */
export function evenMonthlyWeights(): number[] {
  return Array.from({ length: 12 }, () => 1 / 12);
}

/**
 * Resolve the monthly weight vector to use for a goal. Returns the
 * configured vector when it is a valid 12-element array; otherwise falls
 * back to an even allocation.
 */
export function resolveMonthlyWeights(weights: unknown): number[] {
  if (
    Array.isArray(weights) &&
    weights.length === 12 &&
    weights.every((w) => typeof w === "number")
  ) {
    return weights as number[];
  }
  return evenMonthlyWeights();
}
