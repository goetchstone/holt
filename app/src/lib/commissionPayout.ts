// /app/src/lib/commissionPayout.ts
//
// Commission-payout snapshot builder. Origin: owner direction
// 2026-05-27 — needs a lock-it-in record per pay period so retroactive
// changes to SalesOrder data (returns, rewrites, cancellations) don't
// silently rewrite history. Pure helper; the API route does the DB
// I/O and calls in here for the math.
//
// The marginal-tier math itself lives in lib/commissionTiers.ts — we
// reuse `calculateMarginalCommission` so the live preview at the top
// of the report and the locked payout below use the SAME engine.

import { calculateMarginalCommission, type CommissionTier } from "@/lib/commissionTiers";

/**
 * Shape of one tier slice inside `tierBreakdown` JSON on a
 * CommissionPayout row. Mirrors the breakdown the live-preview
 * report shows, so the UI can render either one identically.
 */
export interface PayoutBreakdownEntry {
  tierLabel: string;
  rate: number;
  /** Sales (= YTD slice) that fell inside this tier during the period. */
  sliceAmount: number;
  /** sliceAmount × rate, rounded. */
  sliceCommission: number;
}

/**
 * Frozen snapshot of the CommissionTier rows that were in effect at
 * generation time. Re-rendering a locked payout never reads the live
 * `CommissionTier` table; it reads this snapshot. So an admin editing
 * tiers next quarter doesn't rewrite this quarter's history.
 */
export interface TierDefinitionSnapshot {
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
  sortOrder: number;
}

export interface ComputedPayout {
  staffMemberId: number;
  periodStart: Date;
  periodEnd: Date;
  periodSalesAmount: number;
  ytdSalesAtStart: number;
  ytdSalesAtEnd: number;
  tierBreakdown: PayoutBreakdownEntry[];
  commissionAmount: number;
  tierDefinitionSnapshot: TierDefinitionSnapshot[];
}

export interface ComputePayoutInput {
  staffMemberId: number;
  periodStart: Date;
  periodEnd: Date;
  ytdSalesAtStart: number;
  ytdSalesAtEnd: number;
  tiers: ReadonlyArray<CommissionTier & { sortOrder?: number }>;
}

/**
 * Pure helper. Caller hands in pre-computed sales totals + tier
 * definitions; we produce the row-shaped payout draft.
 *
 * `periodSalesAmount` is the (ytdAtEnd - ytdAtStart) increment.
 * Marginal-tier math walks that slice tier-by-tier; the breakdown
 * captures which tiers contributed how much.
 *
 * Both ends of the period are STORED VERBATIM (no Date manipulation
 * here) so the persisted dates match exactly what the caller picked.
 */
export function computePayoutForRange(input: ComputePayoutInput): ComputedPayout {
  const { staffMemberId, periodStart, periodEnd, ytdSalesAtStart, ytdSalesAtEnd, tiers } = input;

  const result = calculateMarginalCommission(ytdSalesAtStart, ytdSalesAtEnd, tiers);

  const tierBreakdown: PayoutBreakdownEntry[] = result.breakdown.map((b) => ({
    tierLabel: b.tierLabel,
    rate: b.rate,
    sliceAmount: b.salesInTier,
    sliceCommission: b.commission,
  }));

  const tierDefinitionSnapshot: TierDefinitionSnapshot[] = tiers.map((t, i) => ({
    label: t.label,
    minYtdSales: t.minYtdSales,
    maxYtdSalesExclusive: t.maxYtdSalesExclusive,
    rate: t.rate,
    sortOrder: t.sortOrder ?? i,
  }));

  return {
    staffMemberId,
    periodStart,
    periodEnd,
    periodSalesAmount: Math.max(0, ytdSalesAtEnd - ytdSalesAtStart),
    ytdSalesAtStart,
    ytdSalesAtEnd,
    tierBreakdown,
    commissionAmount: result.commission,
    tierDefinitionSnapshot,
  };
}
