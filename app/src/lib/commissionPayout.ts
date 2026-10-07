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
import {
  computeRuleEnginePayout,
  LEGACY_RULE_KEY,
  type CommissionRuleDef,
  type CommissionSaleRow,
  type RuleBasis,
  type RuleAccumulator,
  type RuleTierMode,
  type RuleBreakdownEntry,
  type RulePriorState,
} from "@/lib/commissionRuleEngine";

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

// ---------------------------------------------------------------------------
// Stage 1 rule engine — payout snapshot builder
// ---------------------------------------------------------------------------
//
// Parallel to computePayoutForRange above (kept untouched — still the pure
// helper its own pinned unit tests cover), this wraps
// lib/commissionRuleEngine.ts:computeRuleEnginePayout into the same
// ComputedPayout row-shape the orchestrator writes to CommissionPayout.
// `tierBreakdown` / `tierDefinitionSnapshot` grow a versioned envelope
// (`{schemaVersion: 2, ...}`) instead of the old bare array, and
// `ruleEngineVersion: 2` on the row discriminates it. See
// docs/domains/commission.md "Snapshot — old and new shapes".

/** Frozen tier definition inside a rule-engine snapshot. */
export interface RuleTierSnapshot {
  label: string;
  minAmount: number;
  maxAmountExclusive: number | null;
  rate: number | null;
  perUnitAmount: number | null;
  sortOrder: number;
}

/** Frozen rule definition (scope, basis, accumulator, tierMode + its tiers)
 *  inside a rule-engine snapshot — the generalized replacement for the flat
 *  `TierDefinitionSnapshot[]` array. */
export interface RuleDefSnapshot {
  ruleId: number | null;
  ruleKey: string;
  label: string;
  sortOrder: number;
  scopeDescription: string;
  basis: RuleBasis;
  accumulator: RuleAccumulator;
  tierMode: RuleTierMode;
  tiers: RuleTierSnapshot[];
}

/** `CommissionPayout.tierDefinitionSnapshot` shape when `ruleEngineVersion
 *  = 2`. `ruleState` is the carry-forward chain-continuity data (per rule)
 *  the NEXT period's generation reads back as `priorState` — this is new
 *  information the old scalar-column chain (ytdSalesAtEnd) didn't need to
 *  persist explicitly, because the old model had exactly one implicit
 *  rule. */
export interface RuleSnapshotEnvelope {
  schemaVersion: 2;
  rules: RuleDefSnapshot[];
  ruleState: RulePriorState[];
}

/** `CommissionPayout.tierBreakdown` shape when `ruleEngineVersion = 2`. */
export interface RuleBreakdownEnvelope {
  schemaVersion: 2;
  entries: RuleBreakdownEntry[];
  /** Revenue-basis total of sales in the period that matched no active
   *  rule — visibility only, always $0 commission (see
   *  commissionRuleEngine.ts's `unmatchedAmount` doc comment). */
  unmatchedAmount: number;
}

export interface ComputedRulePayout {
  staffMemberId: number;
  periodStart: Date;
  periodEnd: Date;
  periodSalesAmount: number;
  ytdSalesAtStart: number;
  ytdSalesAtEnd: number;
  tierBreakdown: RuleBreakdownEnvelope;
  commissionAmount: number;
  tierDefinitionSnapshot: RuleSnapshotEnvelope;
  ruleEngineVersion: 2;
}

export interface ComputeRulePayoutInput {
  staffMemberId: number;
  periodStart: Date;
  periodEnd: Date;
  /** Half-open — [periodStart, periodEndExclusive). */
  periodEndExclusive: Date;
  yearStart: Date;
  rules: readonly CommissionRuleDef[];
  saleRows: readonly CommissionSaleRow[];
  priorState: readonly RulePriorState[];
  /**
   * Backward-compatible display fields — computed by the orchestrator
   * INDEPENDENTLY of the rule engine (same `sumDesignerSales` /
   * `computeDesignerYtdSums` path as before Stage 1, untouched), not
   * derived from `rules`/`saleRows` here. They remain REVENUE-basis
   * designer-level totals regardless of how many rules exist or what
   * bases they use — see docs/domains/commission.md "What
   * ytdSalesAtStart/End mean now" for why this boundary is deliberate,
   * not an oversight.
   */
  ytdSalesAtStart: number;
  ytdSalesAtEnd: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeRulePayoutForRange(input: ComputeRulePayoutInput): ComputedRulePayout {
  const engineResult = computeRuleEnginePayout({
    rules: input.rules,
    saleRows: input.saleRows,
    periodStart: input.periodStart,
    periodEndExclusive: input.periodEndExclusive,
    yearStart: input.yearStart,
    priorState: input.priorState,
  });

  const ruleSnapshots: RuleDefSnapshot[] = input.rules.map((r) => ({
    ruleId: r.id,
    ruleKey: r.ruleKey,
    label: r.label,
    sortOrder: r.sortOrder,
    scopeDescription: r.scopeDescription,
    basis: r.basis,
    accumulator: r.accumulator,
    tierMode: r.tierMode,
    tiers: r.tiers.map((t) => ({ ...t })),
  }));

  return {
    staffMemberId: input.staffMemberId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    periodSalesAmount: Math.max(0, round2(input.ytdSalesAtEnd - input.ytdSalesAtStart)),
    ytdSalesAtStart: input.ytdSalesAtStart,
    ytdSalesAtEnd: input.ytdSalesAtEnd,
    tierBreakdown: {
      schemaVersion: 2,
      entries: engineResult.breakdown,
      unmatchedAmount: engineResult.unmatchedAmount,
    },
    commissionAmount: engineResult.commissionAmount,
    tierDefinitionSnapshot: {
      schemaVersion: 2,
      rules: ruleSnapshots,
      ruleState: engineResult.nextState,
    },
    ruleEngineVersion: 2,
  };
}

/**
 * Bridge an OLD-shape (`ruleEngineVersion = 1`) locked payout into
 * `RulePriorState[]` so the FIRST rule-engine generation after this ships
 * chains correctly from pre-existing history instead of treating every
 * designer as brand new. Old-shape rows only ever represent exactly one
 * implicit rule (there was no rule concept before Stage 1), so this maps
 * `ytdSalesAtEnd`/`commissionAmount` onto whichever rule key the caller
 * says is now "primary" for that plan — in practice `rules[0]?.ruleKey`,
 * since every migrated plan resolves to exactly one rule.
 */
export function bridgeLegacyLockToRuleState(
  oldRow: { ytdSalesAtEnd: number; commissionAmount: number },
  primaryRuleKey: string = LEGACY_RULE_KEY,
): RulePriorState[] {
  return [
    {
      ruleKey: primaryRuleKey,
      basisAtEnd: oldRow.ytdSalesAtEnd,
      cumulativeRecognizedCommission: oldRow.commissionAmount,
    },
  ];
}

// ---------------------------------------------------------------------------
// Shape guards — a payout row's tierBreakdown/tierDefinitionSnapshot may be
// EITHER shape depending on `ruleEngineVersion`. Renderers (UI, API
// responses) should branch on `ruleEngineVersion` directly when available;
// these guards exist for code paths (or historical exports) that only have
// the raw JSON value.
// ---------------------------------------------------------------------------

export function isRuleSnapshotEnvelope(value: unknown): value is RuleSnapshotEnvelope {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 2
  );
}

export function isRuleBreakdownEnvelope(value: unknown): value is RuleBreakdownEnvelope {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 2
  );
}

/** True for the pre-Stage-1 flat-array shape (either snapshot or breakdown —
 *  both were bare arrays before the rule engine). */
export function isLegacyArrayShape(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
