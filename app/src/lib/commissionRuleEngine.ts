// /app/src/lib/commissionRuleEngine.ts
//
// Stage 1 commission RULE engine. Pure math — no Prisma, no I/O (rule 14).
// The DB-touching orchestration (loading rules, loading sale rows, chain
// continuity against locked payouts) lives in lib/commissionRules.ts and
// lib/runCommissionPayouts.ts; this file only ever sees plain data in and
// plain data out, which is what makes it exhaustively unit-testable without
// a database.
//
// See docs/domains/commission.md "Rule model" for the full design writeup.
// The short version:
//
//   - A CommissionPlan has an ordered list of RULES (CommissionRuleDef).
//     Each rule has a SCOPE (which sales it applies to — department /
//     category / vendor / store / product type, all-nullable = "matches
//     everything"), a BASIS (REVENUE / MARGIN / UNITS — what dollar or unit
//     figure feeds its tiers), an ACCUMULATOR (YTD / PERIOD /
//     PER_TRANSACTION — what window that figure is measured over), and a
//     TIER MODE (MARGINAL / RETROACTIVE / THRESHOLD — how its tiers convert
//     the accumulated figure into commission).
//   - Every SALE ROW is assigned to AT MOST ONE rule: rules are tried in
//     ascending sortOrder and the FIRST whose scope matches wins
//     (first-match-wins — see `matchRule`'s doc comment for why this beat
//     most-specific-wins). A row matched by no rule earns zero commission
//     and is surfaced in `unmatchedAmount`, never thrown.
//   - Each rule computes its own commission independently from its matched
//     rows, using `priorState` (frozen carry-forward from the most recent
//     LOCKED payout, keyed per rule) for cross-period continuity. The
//     top-level payout commission is the sum across rules.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuleBasis = "REVENUE" | "MARGIN" | "UNITS";
export type RuleAccumulator = "YTD" | "PERIOD" | "PER_TRANSACTION";
export type RuleTierMode = "MARGINAL" | "RETROACTIVE" | "THRESHOLD";

/** Every field nullable; null = "matches everything" for that dimension. */
export interface RuleScope {
  departmentId?: number | null;
  categoryId?: number | null;
  vendorId?: number | null;
  storeLocationId?: number | null;
  productTypeId?: number | null;
}

export interface RuleTierDef {
  label: string;
  minAmount: number;
  /** null = unbounded top tier. */
  maxAmountExclusive: number | null;
  /** Percentage rate (0..1). Exactly one of rate/perUnitAmount is set. */
  rate: number | null;
  /** Flat $ per unit (UNITS basis). Exactly one of rate/perUnitAmount is set. */
  perUnitAmount: number | null;
  sortOrder: number;
}

export interface CommissionRuleDef {
  /** null for a rule synthesized on the fly (legacy-tier derivation), never persisted. */
  id: number | null;
  /**
   * Stable identity for cross-period chain continuity. `id:<n>` for a
   * persisted rule; a caller-supplied synthetic key (e.g.
   * `legacy-ytd-revenue`) for a derived rule, so a designer whose plan
   * hasn't been migrated to real CommissionPlanRule rows yet still chains
   * correctly period over period.
   */
  ruleKey: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  scope: RuleScope;
  /** Human-readable rendering of `scope`, precomputed by the caller (the
   *  engine has no DB access to resolve department/vendor/etc. names). */
  scopeDescription: string;
  basis: RuleBasis;
  accumulator: RuleAccumulator;
  tierMode: RuleTierMode;
  tiers: readonly RuleTierDef[];
}

/** One line's contribution, pre-resolved by the caller (Prisma + the shared
 *  cost-fallback cascade for MARGIN — see lib/marginMath.ts:resolveLineCost).
 *  All three amount fields are always populated; which one a rule actually
 *  uses depends on that rule's `basis`. */
export interface CommissionSaleRow {
  /** Groups rows into a transaction for the PER_TRANSACTION accumulator.
   *  This codebase's transactional unit is one SalesOrder. */
  transactionId: number | string;
  occurredAt: Date;
  revenue: number;
  margin: number;
  units: number;
  departmentId: number | null;
  categoryId: number | null;
  vendorId: number | null;
  storeLocationId: number | null;
  productTypeId: number | null;
}

/** Frozen carry-forward from the most recent LOCKED payout, one entry per
 *  rule (keyed by `ruleKey`). Absent entry = no history for that rule
 *  (first-ever period for it, or it didn't exist at the prior lock). */
export interface RulePriorState {
  ruleKey: string;
  /** This rule's own accumulated basis figure as of the prior lock's
   *  periodEnd. Only meaningful for accumulator = YTD. */
  basisAtEnd: number;
  /** Total commission already recognized (paid) for this rule, YTD, as of
   *  the prior lock. Only meaningful for tierMode = RETROACTIVE. */
  cumulativeRecognizedCommission: number;
}

export interface RuleBreakdownEntry {
  ruleId: number | null;
  ruleKey: string;
  ruleLabel: string;
  scopeDescription: string;
  basis: RuleBasis;
  accumulator: RuleAccumulator;
  tierMode: RuleTierMode;
  tierLabel: string;
  rate: number | null;
  perUnitAmount: number | null;
  /** Dollars (REVENUE/MARGIN) or units (UNITS) this tier is being credited
   *  with this period. For RETROACTIVE this is the full re-rated base
   *  (`basisAtEnd`), not a marginal slice — see `priorRecognized` below to
   *  reconstruct what's newly earned vs already paid. */
  sliceAmount: number;
  sliceCommission: number;
  /** RETROACTIVE / THRESHOLD only. Commission already recognized for this
   *  rule before this period (0 if none). */
  priorRecognized?: number;
  /** RETROACTIVE / THRESHOLD only. priorRecognized + sliceCommission. */
  cumulativeRecognizedAfter?: number;
  /** ISO date the accumulator window this entry covers started. For YTD,
   *  this is `yearStart` — so a lump-sum RETROACTIVE/THRESHOLD recognition
   *  in period 3 is legible as "covers sales from Jan 1 through this
   *  period's end," not a number that appears from nowhere. */
  qualifyingWindowStart?: string;
  qualifyingWindowEnd?: string;
  /**
   * True only for the SECONDARY edge case the owner distinguished from
   * deferred recognition: commission was already paid in an earlier,
   * LOCKED period at a lower rate, and this period's crossing into a new
   * band recognizes an uplift on top of that (never by mutating the old
   * row — see docs/domains/commission.md "Catch-up"). False for the
   * PRIMARY deferred case (nothing was ever recognized before
   * qualification, so there is nothing to "catch up").
   */
  isCatchUp?: boolean;
}

export interface EngineInput {
  /** Every rule on the plan, any order/active-state — the engine sorts and
   *  filters internally. */
  rules: readonly CommissionRuleDef[];
  /**
   * Every sale row potentially relevant to this designer's payout. For any
   * rule with accumulator = YTD, this MUST include every row back to
   * `yearStart` — REGARDLESS of whether `priorState` covers that rule.
   * Only `basisAtStart` uses the frozen prior-lock carry when available;
   * `basisAtEnd` is always a live recompute over the full YTD-to-date row
   * set (see `computeRuleForYtdOrPeriod`'s doc comment for why: a
   * return/rewrite dated inside an already-locked prior period must still
   * net out of the CURRENT period's math). Passing only period-window rows
   * here would silently double-count or under-count whenever data changed
   * inside a previously-locked period after it locked.
   */
  saleRows: readonly CommissionSaleRow[];
  periodStart: Date;
  /** Half-open — the period's last inclusive day is periodEndExclusive minus 1ms. */
  periodEndExclusive: Date;
  /** Jan 1 of the period's year — the YTD accumulator's reset anchor. */
  yearStart: Date;
  priorState: readonly RulePriorState[];
}

export interface EnginePayoutResult {
  commissionAmount: number;
  breakdown: RuleBreakdownEntry[];
  /** Carry-forward state to persist (inside the payout's frozen snapshot)
   *  for the NEXT period's chain continuity. One entry per rule considered
   *  this run (including zero-commission rules, so a rule that matched
   *  nothing this period still correctly carries basisAtEnd forward
   *  unchanged). */
  nextState: RulePriorState[];
  /** Revenue-basis total of sale rows, in the CURRENT period window, that
   *  matched no active rule. Visibility only — always $0 commission for
   *  those rows, never an error (Stage 1 requirement: "a sale matching no
   *  rule must earn zero, not crash"). */
  unmatchedAmount: number;
}

// ---------------------------------------------------------------------------
// Rounding — matches lib/commissionTiers.ts:calculateMarginalCommission's
// rounding sequence exactly (round the per-tier commission, then round the
// running total after each add) so a migrated legacy plan's MARGINAL/YTD/
// REVENUE/scope-all rule produces byte-identical pennies through this engine.
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sanitize(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Scope matching / rule precedence
// ---------------------------------------------------------------------------

/**
 * Does `scope` match `row`? Every non-null scope field must equal the row's
 * corresponding field; null scope fields match anything.
 */
export function scopeMatches(scope: RuleScope, row: CommissionSaleRow): boolean {
  if (scope.departmentId != null && scope.departmentId !== row.departmentId) return false;
  if (scope.categoryId != null && scope.categoryId !== row.categoryId) return false;
  if (scope.vendorId != null && scope.vendorId !== row.vendorId) return false;
  if (scope.storeLocationId != null && scope.storeLocationId !== row.storeLocationId) {
    return false;
  }
  if (scope.productTypeId != null && scope.productTypeId !== row.productTypeId) return false;
  return true;
}

/**
 * PRECEDENCE DECISION (Stage 1, pinned): first-match-wins by ascending
 * `sortOrder`, not most-specific-wins.
 *
 * Why: "most specific" has no principled definition across 5 INDEPENDENT
 * scope dimensions. A rule scoped to {department} and a rule scoped to
 * {storeLocation} both matching the same sale are not orderable by
 * "specificity" without an arbitrary per-dimension priority ranking baked
 * into the engine — which is exactly the kind of implicit, easy-to-
 * misjudge-in-code-review ordering this codebase's rule 42 postmortems
 * (SO-39275) warn against for guards that must apply consistently.
 * First-match-wins instead makes precedence explicit, visible ADMIN DATA
 * (`sortOrder`), not implicit engine logic — the same convention
 * CommissionPlanTier's bracket ordering already uses. Convention for plan
 * authors: put narrow/exception rules at lower sortOrder, the catch-all
 * (all-null scope) rule last. Every migrated legacy plan is exactly one
 * catch-all rule, so this never comes up for existing data.
 *
 * Only ACTIVE rules are matched; inactive rules are skipped as if absent.
 */
export function matchRule(
  row: CommissionSaleRow,
  sortedActiveRules: readonly CommissionRuleDef[],
): CommissionRuleDef | null {
  for (const rule of sortedActiveRules) {
    if (scopeMatches(rule.scope, row)) return rule;
  }
  return null;
}

function sortActiveRules(rules: readonly CommissionRuleDef[]): CommissionRuleDef[] {
  return rules
    .filter((r) => r.isActive)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

interface BucketResult {
  byRuleKey: Map<string, CommissionSaleRow[]>;
  unmatched: CommissionSaleRow[];
}

function bucketRowsByRule(
  rows: readonly CommissionSaleRow[],
  sortedActiveRules: readonly CommissionRuleDef[],
): BucketResult {
  const byRuleKey = new Map<string, CommissionSaleRow[]>();
  const unmatched: CommissionSaleRow[] = [];
  for (const row of rows) {
    const rule = matchRule(row, sortedActiveRules);
    if (!rule) {
      unmatched.push(row);
      continue;
    }
    const bucket = byRuleKey.get(rule.ruleKey);
    if (bucket) bucket.push(row);
    else byRuleKey.set(rule.ruleKey, [row]);
  }
  return { byRuleKey, unmatched };
}

function basisValue(row: CommissionSaleRow, basis: RuleBasis): number {
  if (basis === "REVENUE") return row.revenue;
  if (basis === "MARGIN") return row.margin;
  return row.units;
}

function sumBasis(rows: readonly CommissionSaleRow[], basis: RuleBasis): number {
  let total = 0;
  for (const row of rows) total += basisValue(row, basis);
  return total;
}

// ---------------------------------------------------------------------------
// Tier validation
// ---------------------------------------------------------------------------

/**
 * Bracket + shape validation for one rule's tiers: label present, minAmount
 * >= 0, exactly one of rate (0..1) / perUnitAmount (>=0) set per tier,
 * brackets contiguous + ascending, only the LAST tier may be unbounded.
 * Mirrors lib/commissionPlans.ts:validatePlanTiers' rules generalized to the
 * rate-or-perUnitAmount choice. Returns an error message or null.
 */
/** Per-tier field validation: label, minAmount, and the rate-XOR-perUnitAmount
 *  choice. Split out of validateRuleTiers so its cognitive complexity stays
 *  under the lint threshold (mirrors commissionPlans.ts:validateTierFields'
 *  identical split). */
function validateRuleTierFields(t: RuleTierDef, i: number): string | null {
  if (!t.label) return `Tier ${i + 1}: missing label`;
  if (typeof t.minAmount !== "number" || t.minAmount < 0) {
    return `Tier ${i + 1} (${t.label}): minAmount must be >= 0`;
  }
  const hasRate = t.rate !== null && t.rate !== undefined;
  const hasPerUnit = t.perUnitAmount !== null && t.perUnitAmount !== undefined;
  if (hasRate === hasPerUnit) {
    return `Tier ${i + 1} (${t.label}): exactly one of rate or perUnitAmount must be set`;
  }
  if (hasRate && (t.rate! < 0 || t.rate! > 1)) {
    return `Tier ${i + 1} (${t.label}): rate must be between 0 and 1`;
  }
  if (hasPerUnit && t.perUnitAmount! < 0) {
    return `Tier ${i + 1} (${t.label}): perUnitAmount must be >= 0`;
  }
  return null;
}

/** Bracket contiguity/unbounded-ness validation. Split out of
 *  validateRuleTiers for the same reason as validateRuleTierFields. */
function validateRuleTierBrackets(
  t: RuleTierDef,
  i: number,
  sorted: readonly RuleTierDef[],
): string | null {
  const isLast = i === sorted.length - 1;
  if (isLast) {
    if (t.maxAmountExclusive !== null && t.maxAmountExclusive <= t.minAmount) {
      return `Tier ${i + 1} (${t.label}): maxAmountExclusive must be > minAmount`;
    }
    return null;
  }
  if (t.maxAmountExclusive === null) {
    return `Tier ${i + 1} (${t.label}): only the last tier may be unbounded`;
  }
  if (t.maxAmountExclusive <= t.minAmount) {
    return `Tier ${i + 1} (${t.label}): maxAmountExclusive must be > minAmount`;
  }
  if (sorted[i + 1].minAmount !== t.maxAmountExclusive) {
    return `Tiers ${i + 1} -> ${i + 2}: brackets must be contiguous`;
  }
  return null;
}

export function validateRuleTiers(tiers: readonly RuleTierDef[]): string | null {
  if (tiers.length === 0) return "A rule needs at least one tier";
  const sorted = tiers.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  for (const [i, t] of sorted.entries()) {
    const fieldError = validateRuleTierFields(t, i);
    if (fieldError) return fieldError;
    const bracketError = validateRuleTierBrackets(t, i, sorted);
    if (bracketError) return bracketError;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier-mode math
// ---------------------------------------------------------------------------

function tierMultiplier(t: RuleTierDef): number {
  return t.rate ?? t.perUnitAmount ?? 0;
}

/**
 * MARGINAL (and THRESHOLD — see doc comment on applyTierMode) core: sum,
 * tier by tier, of the overlap between [start, end) and each tier's
 * [minAmount, maxAmountExclusive) bracket, times that tier's rate/
 * perUnitAmount. Identical algorithm and rounding sequence to
 * lib/commissionTiers.ts:calculateMarginalCommission, generalized to accept
 * a perUnitAmount tier alongside a rate tier.
 */
export function marginalOverlapSum(
  tiers: readonly RuleTierDef[],
  start: number,
  end: number,
): {
  total: number;
  entries: Array<{ tier: RuleTierDef; sliceAmount: number; sliceCommission: number }>;
} {
  const safeStart = sanitize(start);
  const safeEnd = sanitize(end);
  const entries: Array<{ tier: RuleTierDef; sliceAmount: number; sliceCommission: number }> = [];
  if (safeEnd <= safeStart || tiers.length === 0) return { total: 0, entries };

  const sorted = tiers.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  let total = 0;
  for (const tier of sorted) {
    const tierMax = tier.maxAmountExclusive ?? Number.POSITIVE_INFINITY;
    const overlapStart = Math.max(safeStart, tier.minAmount);
    const overlapEnd = Math.min(safeEnd, tierMax);
    const slice = overlapEnd - overlapStart;
    if (slice <= 0) continue;
    const sliceCommission = round2(slice * tierMultiplier(tier));
    total = round2(total + sliceCommission);
    entries.push({ tier, sliceAmount: round2(slice), sliceCommission });
  }
  return { total, entries };
}

/** The tier whose [minAmount, maxAmountExclusive) bracket contains `x`, or
 *  null if `x` is below every tier's minAmount (unqualified / deferred). */
export function tierContaining(tiers: readonly RuleTierDef[], x: number): RuleTierDef | null {
  const safe = sanitize(x);
  const sorted = tiers.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  for (const t of sorted) {
    const max = t.maxAmountExclusive ?? Number.POSITIVE_INFINITY;
    if (safe >= t.minAmount && safe < max) return t;
  }
  return null;
}

/**
 * RETROACTIVE core: "what is owed IN TOTAL, right now, if x re-rates
 * entirely at the rate of the band it currently sits in." Below the lowest
 * tier's minAmount, owed is 0 (unqualified — RETROACTIVE with a tier
 * starting above $0 IS the deferred-goal shape; see docs/domains/
 * commission.md "Tier modes").
 */
export function retroactiveOwedAt(tiers: readonly RuleTierDef[], x: number): number {
  const t = tierContaining(tiers, x);
  if (!t) return 0;
  return round2(tierMultiplier(t) * sanitize(x));
}

interface WindowLabel {
  start: string;
  end: string;
}

interface RuleMeta {
  ruleId: number | null;
  ruleKey: string;
  ruleLabel: string;
  scopeDescription: string;
  basis: RuleBasis;
  accumulator: RuleAccumulator;
  tierMode: RuleTierMode;
}

/**
 * Apply one rule's tierMode to its [basisAtStart, basisAtEnd) window for the
 * CURRENT period, given `priorRecognized` (0 unless tierMode is RETROACTIVE
 * and a prior lock carried a nonzero cumulative-recognized value forward).
 *
 * MARGINAL and THRESHOLD share the exact same math (`marginalOverlapSum`):
 * both pay each tier's rate on the OVERLAP between the period's window and
 * that tier's band, with no cross-period carry beyond basisAtEnd itself.
 * The only real difference is intent/shape — a THRESHOLD rule's tiers
 * conventionally start above $0 (the "goal"), so amounts below the goal
 * naturally overlap no tier and earn $0, deferring recognition until the
 * goal is crossed and then paying marginally on the excess ("prospective"
 * scope). A MARGINAL rule's tiers conventionally start at $0. Keeping them
 * on one code path (rather than two near-duplicate implementations) is the
 * rule-6/7 reuse call; both are still independently unit-tested and
 * independently labeled in the breakdown (`tierMode` field) so the
 * distinction stays visible to a reader even though the arithmetic is
 * shared.
 */
function applyTierMode(
  rule: CommissionRuleDef,
  basisAtStart: number,
  basisAtEnd: number,
  priorRecognized: number,
  window: WindowLabel,
): { commission: number; entries: RuleBreakdownEntry[] } {
  const meta: RuleMeta = {
    ruleId: rule.id,
    ruleKey: rule.ruleKey,
    ruleLabel: rule.label,
    scopeDescription: rule.scopeDescription,
    basis: rule.basis,
    accumulator: rule.accumulator,
    tierMode: rule.tierMode,
  };

  if (rule.tierMode === "MARGINAL" || rule.tierMode === "THRESHOLD") {
    const { total, entries: rawEntries } = marginalOverlapSum(rule.tiers, basisAtStart, basisAtEnd);
    const entries: RuleBreakdownEntry[] = rawEntries.map((e) => ({
      ...meta,
      tierLabel: e.tier.label,
      rate: e.tier.rate,
      perUnitAmount: e.tier.perUnitAmount,
      sliceAmount: e.sliceAmount,
      sliceCommission: e.sliceCommission,
    }));
    return { commission: total, entries };
  }

  // RETROACTIVE
  const owedAtEnd = retroactiveOwedAt(rule.tiers, basisAtEnd);
  const priorRecognizedSafe = round2(sanitize(priorRecognized));
  const commission = Math.max(0, round2(owedAtEnd - priorRecognizedSafe));
  const cumulativeRecognizedAfter = round2(priorRecognizedSafe + commission);

  if (commission === 0 && priorRecognizedSafe === 0) {
    // Never qualified, nothing recognized, nothing paid — clean zero, no
    // breakdown noise. (Stage 1 requirement: an unreachable/never-met
    // threshold yields zero commission cleanly, not an error.)
    return { commission: 0, entries: [] };
  }

  const containing = tierContaining(rule.tiers, basisAtEnd);
  const entry: RuleBreakdownEntry = {
    ...meta,
    tierLabel: containing?.label ?? "Below goal — not yet qualified",
    rate: containing?.rate ?? null,
    perUnitAmount: containing?.perUnitAmount ?? null,
    sliceAmount: round2(sanitize(basisAtEnd)),
    sliceCommission: commission,
    priorRecognized: priorRecognizedSafe,
    cumulativeRecognizedAfter,
    qualifyingWindowStart: window.start,
    qualifyingWindowEnd: window.end,
    isCatchUp: priorRecognizedSafe > 0 && commission > 0,
  };
  return { commission, entries: [entry] };
}

// ---------------------------------------------------------------------------
// Per-rule window resolution (accumulator handling)
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function computeRuleForYtdOrPeriod(
  rule: CommissionRuleDef,
  rows: readonly CommissionSaleRow[],
  ctx: {
    periodStart: Date;
    periodEndExclusive: Date;
    yearStart: Date;
    priorEntry: RulePriorState | undefined;
  },
): {
  commission: number;
  entries: RuleBreakdownEntry[];
  nextBasisAtEnd: number;
  nextCumulativeRecognized: number;
} {
  let basisAtStart: number;
  let basisAtEnd: number;
  let priorRecognized: number;
  let windowStart: Date;

  if (rule.accumulator === "YTD") {
    // basisAtEnd is ALWAYS a LIVE full recompute over every matched row up
    // to periodEndExclusive — mirrors the pre-Stage-1 chain continuity
    // exactly (runCommissionPayouts.ts's computeDesignerYtdSums: ytdAtEnd
    // is unconditionally live even when ytdAtStart is pinned to a prior
    // lock). This is why a return/rewrite dated INSIDE an already-LOCKED
    // prior period, but landing after that lock, still nets out of the
    // CURRENT period's math — without ever touching the locked row.
    // Only basisAtSTART is frozen (when a prior lock provides one); using
    // "frozen start + period-only slice" for the END instead of a live
    // recompute would silently miss that late-landing return (it shows up
    // as drift on the OLD row, not as a correction to the new one — see
    // lib/commissionDrift.ts).
    const rowsThroughEnd = rows.filter((r) => r.occurredAt < ctx.periodEndExclusive);
    basisAtEnd = round2(sumBasis(rowsThroughEnd, rule.basis));
    if (ctx.priorEntry) {
      basisAtStart = ctx.priorEntry.basisAtEnd;
      priorRecognized = ctx.priorEntry.cumulativeRecognizedCommission;
    } else {
      const priorRows = rows.filter((r) => r.occurredAt < ctx.periodStart);
      basisAtStart = round2(sumBasis(priorRows, rule.basis));
      priorRecognized = 0;
    }
    windowStart = ctx.yearStart;
  } else {
    // PERIOD — always resets; no cross-period carry, even if a priorEntry
    // happens to be present (a rule can switch accumulator over time; the
    // current config always wins for how THIS period computes).
    const periodRows = rows.filter(
      (r) => r.occurredAt >= ctx.periodStart && r.occurredAt < ctx.periodEndExclusive,
    );
    basisAtStart = 0;
    basisAtEnd = round2(sumBasis(periodRows, rule.basis));
    priorRecognized = 0;
    windowStart = ctx.periodStart;
  }

  const periodEndInclusive = new Date(ctx.periodEndExclusive.getTime() - 1);
  const { commission, entries } = applyTierMode(rule, basisAtStart, basisAtEnd, priorRecognized, {
    start: isoDate(windowStart),
    end: isoDate(periodEndInclusive),
  });

  // nextCumulativeRecognized: for RETROACTIVE this is priorRecognized +
  // whatever was newly recognized this period (read back off the single
  // entry, since applyTierMode already computed it); for MARGINAL/THRESHOLD
  // there's no cross-period "recognized" carry beyond basisAtEnd itself, so
  // it's always 0 (also always 0 for PERIOD accumulator, any tierMode).
  const nextCumulativeRecognized =
    rule.accumulator === "YTD" && rule.tierMode === "RETROACTIVE"
      ? (entries[0]?.cumulativeRecognizedAfter ?? priorRecognized)
      : 0;

  return {
    commission,
    entries,
    nextBasisAtEnd: rule.accumulator === "YTD" ? basisAtEnd : 0,
    nextCumulativeRecognized,
  };
}

function computeRuleForPerTransaction(
  rule: CommissionRuleDef,
  rows: readonly CommissionSaleRow[],
  ctx: { periodStart: Date; periodEndExclusive: Date },
): { commission: number; entries: RuleBreakdownEntry[] } {
  const periodRows = rows.filter(
    (r) => r.occurredAt >= ctx.periodStart && r.occurredAt < ctx.periodEndExclusive,
  );
  const byTxn = new Map<string, number>();
  for (const row of periodRows) {
    const key = String(row.transactionId);
    byTxn.set(key, (byTxn.get(key) ?? 0) + basisValue(row, rule.basis));
  }

  const meta: RuleMeta = {
    ruleId: rule.id,
    ruleKey: rule.ruleKey,
    ruleLabel: rule.label,
    scopeDescription: rule.scopeDescription,
    basis: rule.basis,
    accumulator: rule.accumulator,
    tierMode: rule.tierMode,
  };

  // Aggregate per-tier across every transaction so the breakdown stays one
  // row per (rule, tier) for the period, not one row per order.
  const byTierLabel = new Map<
    string,
    { tier: RuleTierDef | null; sliceAmount: number; sliceCommission: number }
  >();
  let commission = 0;

  for (const txnTotal of byTxn.values()) {
    if (rule.tierMode === "RETROACTIVE") {
      const owed = retroactiveOwedAt(rule.tiers, txnTotal);
      if (owed === 0) continue;
      commission = round2(commission + owed);
      const containing = tierContaining(rule.tiers, txnTotal);
      const key = containing?.label ?? "unqualified";
      const existing = byTierLabel.get(key);
      if (existing) {
        existing.sliceAmount = round2(existing.sliceAmount + txnTotal);
        existing.sliceCommission = round2(existing.sliceCommission + owed);
      } else {
        byTierLabel.set(key, {
          tier: containing,
          sliceAmount: round2(txnTotal),
          sliceCommission: owed,
        });
      }
    } else {
      // MARGINAL / THRESHOLD: each transaction is its own [0, total) window.
      const { total, entries } = marginalOverlapSum(rule.tiers, 0, txnTotal);
      if (total === 0) continue;
      commission = round2(commission + total);
      for (const e of entries) {
        const key = e.tier.label;
        const existing = byTierLabel.get(key);
        if (existing) {
          existing.sliceAmount = round2(existing.sliceAmount + e.sliceAmount);
          existing.sliceCommission = round2(existing.sliceCommission + e.sliceCommission);
        } else {
          byTierLabel.set(key, e);
        }
      }
    }
  }

  const entries: RuleBreakdownEntry[] = Array.from(byTierLabel.values()).map((v) => ({
    ...meta,
    tierLabel: v.tier?.label ?? "unqualified",
    rate: v.tier?.rate ?? null,
    perUnitAmount: v.tier?.perUnitAmount ?? null,
    sliceAmount: v.sliceAmount,
    sliceCommission: v.sliceCommission,
  }));

  return { commission, entries };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * PURE function: (plan rules, sale rows, period context) -> payout
 * breakdown. See the module doc comment for the overall model.
 */
export function computeRuleEnginePayout(input: EngineInput): EnginePayoutResult {
  const sorted = sortActiveRules(input.rules);
  const { byRuleKey, unmatched } = bucketRowsByRule(input.saleRows, sorted);
  const priorByKey = new Map(input.priorState.map((p) => [p.ruleKey, p]));

  let commissionAmount = 0;
  const breakdown: RuleBreakdownEntry[] = [];
  const nextState: RulePriorState[] = [];

  for (const rule of sorted) {
    const rows = byRuleKey.get(rule.ruleKey) ?? [];
    if (rule.accumulator === "PER_TRANSACTION") {
      const { commission, entries } = computeRuleForPerTransaction(rule, rows, {
        periodStart: input.periodStart,
        periodEndExclusive: input.periodEndExclusive,
      });
      commissionAmount = round2(commissionAmount + commission);
      breakdown.push(...entries);
      nextState.push({ ruleKey: rule.ruleKey, basisAtEnd: 0, cumulativeRecognizedCommission: 0 });
      continue;
    }

    const priorEntry = priorByKey.get(rule.ruleKey);
    const result = computeRuleForYtdOrPeriod(rule, rows, {
      periodStart: input.periodStart,
      periodEndExclusive: input.periodEndExclusive,
      yearStart: input.yearStart,
      priorEntry,
    });
    commissionAmount = round2(commissionAmount + result.commission);
    breakdown.push(...result.entries);
    nextState.push({
      ruleKey: rule.ruleKey,
      basisAtEnd: result.nextBasisAtEnd,
      cumulativeRecognizedCommission: result.nextCumulativeRecognized,
    });
  }

  const unmatchedInPeriod = unmatched.filter(
    (r) => r.occurredAt >= input.periodStart && r.occurredAt < input.periodEndExclusive,
  );
  const unmatchedAmount = round2(sumBasis(unmatchedInPeriod, "REVENUE"));

  return { commissionAmount, breakdown, nextState, unmatchedAmount };
}

// ---------------------------------------------------------------------------
// Legacy-tier derivation — converts a flat CommissionPlanTier[] /
// CommissionTier[] set (the {label, minYtdSales, maxYtdSalesExclusive, rate,
// sortOrder} shape) into an equivalent single scope-all/REVENUE/YTD/MARGINAL
// CommissionRuleDef. Pure (no DB) so it's usable both by the data migration
// (conceptually — the migration itself is SQL) and by
// lib/commissionRules.ts's on-the-fly derivation for a plan that hasn't
// gotten real CommissionPlanRule rows (or the bare legacy CommissionTier
// table). This is THE function that makes
// backwards compatibility provable: run it over any existing tier set and
// the resulting rule, fed through computeRuleEnginePayout, must match
// calculateMarginalCommission's output exactly (pinned by the equivalence
// test in __tests__/commissionRuleEngine.test.ts).
// ---------------------------------------------------------------------------

export const LEGACY_RULE_KEY = "legacy-ytd-revenue";
export const LEGACY_RULE_LABEL = "All sales (YTD, marginal)";

/**
 * Label of the single auto-managed CommissionPlanRule that
 * lib/commissionPlans.ts:replacePlanTiers/createPlan keep in sync with a
 * plan's CommissionPlanTier rows on every write (see those functions'
 * `syncLegacyMirrorRule` doc comment). MUST match exactly what the
 * 20260801_commission_rule_engine data migration inserts, so the very
 * first post-migration tier edit UPDATES that row in place (preserving its
 * id, hence its `id:<n>` ruleKey and chain continuity) instead of creating
 * a duplicate rule alongside it.
 */
export const LEGACY_MIRROR_RULE_LABEL = "All sales (YTD, marginal) — auto-synced from tiers";

export interface LegacyTierRow {
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
  sortOrder: number;
}

export function deriveRuleFromLegacyTiers(
  tiers: readonly LegacyTierRow[],
  opts?: { ruleId?: number | null; ruleKey?: string; label?: string },
): CommissionRuleDef {
  return {
    id: opts?.ruleId ?? null,
    ruleKey: opts?.ruleKey ?? LEGACY_RULE_KEY,
    label: opts?.label ?? LEGACY_RULE_LABEL,
    sortOrder: 0,
    isActive: true,
    scope: {},
    scopeDescription: "All sales",
    basis: "REVENUE",
    accumulator: "YTD",
    tierMode: "MARGINAL",
    tiers: tiers.map((t) => ({
      label: t.label,
      minAmount: t.minYtdSales,
      maxAmountExclusive: t.maxYtdSalesExclusive,
      rate: t.rate,
      perUnitAmount: null,
      sortOrder: t.sortOrder,
    })),
  };
}
