// /app/src/lib/marginMath.ts
//
// Pure helpers for the sales-by-salesperson report. Math only -- no
// Prisma, no I/O. A-grade tested in __tests__/marginMath.test.ts.

/**
 * Single line item's contribution to a row in the report. The shape is
 * intentionally narrow: exactly the fields needed for retail/cost/margin
 * math, with split-attribution multiplier already factored in by the
 * caller. Decoupling the math from Prisma keeps it testable in isolation.
 */
export interface MarginLine {
  retail: number; // OrderLineItem.netPrice (line total, NOT per-unit)
  cost: number; // OrderLineItem.cost (line cost)
}

/**
 * Aggregated totals for a salesperson or department row.
 */
export interface MarginRow {
  retail: number;
  cost: number;
  margin: number; // retail - cost
  marginPct: number; // 0..1, NaN-safe (returns 0 if retail is 0)
  itemCount: number;
}

const ZERO_ROW: MarginRow = {
  retail: 0,
  cost: 0,
  margin: 0,
  marginPct: 0,
  itemCount: 0,
};

/**
 * Round to 2 decimal places. Avoids float drift across many additions.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reduces an array of MarginLine into a single MarginRow.
 *
 * - retail/cost are summed and round2'd at the end (one rounding, not per-line)
 * - margin = retail - cost
 * - marginPct = margin / retail, with 0 retail returning 0 (NOT NaN or Infinity)
 * - itemCount counts non-zero-retail lines (matches the Detailed Sales convention)
 */
export function aggregateMargin(lines: readonly MarginLine[]): MarginRow {
  if (lines.length === 0) return { ...ZERO_ROW };

  let retailSum = 0;
  let costSum = 0;
  let positiveLineCount = 0;
  for (const line of lines) {
    retailSum += line.retail;
    costSum += line.cost;
    if (line.retail > 0) positiveLineCount += 1;
  }

  const retail = round2(retailSum);
  const cost = round2(costSum);
  const margin = round2(retail - cost);
  // Use the zero-check up front (flipped from `!== 0` for Sonar S7735)
  // so the divide branch is the natural return value. Negative retail
  // (return-day lines) still produces a meaningful margin %: -600 /
  // -1000 = 0.6 (60%), the same as the original sale.
  const marginPct = retail === 0 ? 0 : margin / retail;

  return {
    retail,
    cost,
    margin,
    marginPct,
    itemCount: positiveLineCount,
  };
}

/**
 * Format margin% as a display string. E.g., 0.354 -> "35.4%".
 * Negative margin is shown with a minus sign, never as a positive %.
 */
export function formatMarginPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${(pct * 100).toFixed(1)}%`;
}

/**
 * Apply split attribution to a line. If the order is a 50/50 split,
 * each salesperson gets credit for HALF the retail and HALF the cost.
 * The cost halving is critical: margin% must stay the same regardless
 * of split status (a $1000 retail / $400 cost line is 60% margin
 * whether one or two salespeople get credit).
 */
export function applySplit(line: MarginLine, isSplit: boolean): MarginLine {
  if (!isSplit) return line;
  return {
    retail: line.retail * 0.5,
    cost: line.cost * 0.5,
  };
}

/**
 * When a line has a non-zero retail but a zero cost, treat its cost as
 * `retail / 2` so margin% comes out to 50% rather than the misleading
 * 100% you'd get from cost == 0. This is the interim imputation rule
 * the user asked for on 2026-04-29 -- many auto-created products
 * (especially from the POS imports without a vendor cost feed) land
 * with cost = 0, and the report would otherwise paint them as pure
 * profit.
 *
 * Sign-preserving: a return line with retail = -1000 and cost = 0
 * becomes cost = -500 (still 50% margin on the reversal).
 *
 * Idempotent on already-populated lines: cost != 0 is left alone.
 *
 * Idempotent on zero-retail lines: there's nothing to impute from,
 * so { retail: 0, cost: 0 } stays as-is.
 *
 * Apply this BEFORE applySplit and BEFORE aggregateMargin -- it's a
 * data-cleaning step. Order doesn't actually matter (split halves both
 * sides so the imputed margin% survives), but the data-cleaning-first
 * convention makes the pipeline easier to reason about.
 */
export function imputeMissingCost(line: MarginLine): MarginLine {
  if (line.cost !== 0) return line;
  if (line.retail === 0) return line;
  return { retail: line.retail, cost: line.retail / 2 };
}
