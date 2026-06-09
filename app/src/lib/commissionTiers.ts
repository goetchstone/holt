// /app/src/lib/commissionTiers.ts
//
// Designer commission tier calculator. Sensitive — pages / endpoints
// that consume this gate on SUPER_ADMIN.
//
// MARGINAL structure: "once you hit X then you get Y going forward."
//
// Each tier's rate applies to the slice of YTD sales that falls
// inside [minYtdSales, maxYtdSalesExclusive). Crossing into a higher
// tier earns the new rate on the ABOVE-THRESHOLD portion only — the
// already-earned portion stays at its original rate.
//
// Tiers are stored in the `CommissionTier` table and edited by
// SUPER_ADMIN on the commission-tiers report page. `DEFAULT_COMMISSION_TIERS`
// below is a starter template used only when the table is empty; edit the
// tiers in-app to match the business.

export interface CommissionTier {
  /** Inclusive lower bound of YTD sales. */
  minYtdSales: number;
  /** Exclusive upper bound. `null` means "no upper bound" (top tier). */
  maxYtdSalesExclusive: number | null;
  /** Decimal rate applied to the portion of YTD sales inside this tier. */
  rate: number;
  /** Short human label for UI rendering. */
  label: string;
}

/**
 * Default tier set — used as a fallback when no DB rows exist (e.g.
 * fresh dev DBs) and as the reference values for the seed migration.
 * The DB row in `CommissionTier` is the authoritative source at
 * runtime.
 */
export const DEFAULT_COMMISSION_TIERS: readonly CommissionTier[] = [
  { minYtdSales: 0, maxYtdSalesExclusive: 750_000, rate: 0.03, label: "Up to $750k" },
  { minYtdSales: 750_000, maxYtdSalesExclusive: 1_000_000, rate: 0.04, label: "$750k – $1M" },
  { minYtdSales: 1_000_000, maxYtdSalesExclusive: 1_500_000, rate: 0.05, label: "$1M – $1.5M" },
  { minYtdSales: 1_500_000, maxYtdSalesExclusive: 2_000_000, rate: 0.06, label: "$1.5M – $2M" },
  { minYtdSales: 2_000_000, maxYtdSalesExclusive: null, rate: 0.07, label: "Over $2M" },
];

export interface MarginalCommissionResult {
  /** Commission earned on the portion (ytdAtEnd - ytdAtStart). */
  commission: number;
  /** Per-tier breakdown: which tiers contributed, and how much each. */
  breakdown: ReadonlyArray<{
    tierLabel: string;
    rate: number;
    salesInTier: number;
    commission: number;
  }>;
}

/**
 * Compute the marginal commission earned on the SLICE between
 * `ytdAtStart` and `ytdAtEnd`.
 *
 * The "tiers are not retroactive" rule means: any sales below
 * `ytdAtStart` already earned commission in a prior period and are
 * NOT recomputed here. Only the (ytdAtEnd - ytdAtStart) increment is
 * commissioned, with each subslice paid at the rate of the tier it
 * falls into.
 *
 * Worked example with default tiers:
 *   ytdAtStart = $800,000
 *   ytdAtEnd   = $1,050,000  (so $250k of new sales in the window)
 *
 *   Tier 2 ($750k–$1M, 4%): overlap = ($1M - $800k) = $200k -> $8,000
 *   Tier 3 ($1M–$1.5M, 5%): overlap = ($1.05M - $1M) = $50k -> $2,500
 *   Total commission for the window: $10,500
 *
 * Defensive: NaN / Infinity / negative slices return zero. A negative
 * slice (ytdAtEnd < ytdAtStart) means the designer's YTD shrank
 * (e.g. heavy returns) and gets $0 commission for the window.
 */
export function calculateMarginalCommission(
  ytdAtStart: number,
  ytdAtEnd: number,
  tiers: readonly CommissionTier[] = DEFAULT_COMMISSION_TIERS,
): MarginalCommissionResult {
  const safeStart = sanitize(ytdAtStart);
  const safeEnd = sanitize(ytdAtEnd);

  if (safeEnd <= safeStart || tiers.length === 0) {
    return { commission: 0, breakdown: [] };
  }

  const breakdown: Array<{
    tierLabel: string;
    rate: number;
    salesInTier: number;
    commission: number;
  }> = [];
  let total = 0;

  // Iterate tiers in their natural order. A tier overlaps the window
  // [start, end) when its bracket [minYtdSales, maxYtdSalesExclusive)
  // intersects [start, end). The overlap width × rate is what's owed
  // from that tier.
  for (const tier of tiers) {
    const tierMax = tier.maxYtdSalesExclusive ?? Number.POSITIVE_INFINITY;
    const overlapStart = Math.max(safeStart, tier.minYtdSales);
    const overlapEnd = Math.min(safeEnd, tierMax);
    const slice = overlapEnd - overlapStart;
    if (slice <= 0) continue;
    const tierCommission = round2(slice * tier.rate);
    total = round2(total + tierCommission);
    breakdown.push({
      tierLabel: tier.label,
      rate: tier.rate,
      salesInTier: round2(slice),
      commission: tierCommission,
    });
  }

  return { commission: total, breakdown };
}

/**
 * Find which single tier a YTD sales total currently sits in (the
 * tier whose bracket contains the value). Used for UI rendering of
 * "current tier" tags. Distinct from `calculateMarginalCommission`
 * which spans multiple tiers across a window.
 */
export function resolveTier(
  ytdSales: number,
  tiers: readonly CommissionTier[] = DEFAULT_COMMISSION_TIERS,
): CommissionTier {
  const safe = Math.max(0, sanitize(ytdSales));
  for (const tier of tiers) {
    const tierMax = tier.maxYtdSalesExclusive ?? Number.POSITIVE_INFINITY;
    if (safe >= tier.minYtdSales && safe < tierMax) return tier;
  }
  // Caller invariant: `tiers` is non-empty (DEFAULT_COMMISSION_TIERS always
  // has 5 rows; the editor enforces >=1 row in validateTiers). The last
  // tier is the unbounded ceiling, so any `safe` above all min/max bounds
  // falls here.
  return tiers.at(-1) as CommissionTier;
}

function sanitize(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
