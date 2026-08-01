// /app/__tests__/commissionRuleEngine.test.ts
//
// Pure-engine tests for the Stage 1 commission rule model
// (lib/commissionRuleEngine.ts). No DB — everything here is plain data in,
// plain data out. See docs/domains/commission.md "Rule model" for the design
// writeup these tests pin.

import {
  computeRuleEnginePayout,
  deriveRuleFromLegacyTiers,
  marginalOverlapSum,
  retroactiveOwedAt,
  tierContaining,
  matchRule,
  scopeMatches,
  validateRuleTiers,
  LEGACY_RULE_KEY,
  type CommissionRuleDef,
  type CommissionSaleRow,
  type RulePriorState,
  type EngineInput,
} from "../src/lib/commissionRuleEngine";
import { calculateMarginalCommission, DEFAULT_COMMISSION_TIERS } from "../src/lib/commissionTiers";

const YEAR_START = new Date("2026-01-01T00:00:00Z");

function row(overrides: Partial<CommissionSaleRow> & { revenue: number }): CommissionSaleRow {
  return {
    transactionId: overrides.transactionId ?? 1,
    occurredAt: overrides.occurredAt ?? new Date("2026-05-20T00:00:00Z"),
    revenue: overrides.revenue,
    margin: overrides.margin ?? overrides.revenue,
    units: overrides.units ?? 1,
    departmentId: overrides.departmentId ?? null,
    categoryId: overrides.categoryId ?? null,
    vendorId: overrides.vendorId ?? null,
    storeLocationId: overrides.storeLocationId ?? null,
    productTypeId: overrides.productTypeId ?? null,
  };
}

function flatRule(overrides: Partial<CommissionRuleDef> = {}): CommissionRuleDef {
  return {
    id: null,
    ruleKey: "flat",
    label: "Flat",
    sortOrder: 0,
    isActive: true,
    scope: {},
    scopeDescription: "All sales",
    basis: "REVENUE",
    accumulator: "YTD",
    tierMode: "MARGINAL",
    tiers: [
      {
        label: "Flat 5%",
        minAmount: 0,
        maxAmountExclusive: null,
        rate: 0.05,
        perUnitAmount: null,
        sortOrder: 0,
      },
    ],
    ...overrides,
  };
}

function baseInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    rules: [],
    saleRows: [],
    periodStart: new Date("2026-05-16T00:00:00Z"),
    periodEndExclusive: new Date("2026-06-01T00:00:00Z"),
    yearStart: YEAR_START,
    priorState: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Single flat rate
// ---------------------------------------------------------------------------

describe("single flat-rate rule (MARGINAL, one tier)", () => {
  it("5% flat on $100k = $5,000", () => {
    const result = computeRuleEnginePayout(
      baseInput({
        rules: [flatRule()],
        saleRows: [row({ revenue: 100_000 })],
      }),
    );
    expect(result.commissionAmount).toBe(5_000);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]).toMatchObject({
      ruleKey: "flat",
      tierLabel: "Flat 5%",
      rate: 0.05,
      sliceAmount: 100_000,
      sliceCommission: 5_000,
    });
  });

  it("zero sales -> zero commission, empty breakdown, no crash", () => {
    const result = computeRuleEnginePayout(baseInput({ rules: [flatRule()], saleRows: [] }));
    expect(result.commissionAmount).toBe(0);
    expect(result.breakdown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multi-band YTD marginal crossing — the existing (pre-Stage-1) behavior,
// reproduced through the new engine via a rule derived from the legacy tiers.
// ---------------------------------------------------------------------------

describe("multi-band YTD MARGINAL crossing (today's behavior, generalized)", () => {
  const legacyRule = deriveRuleFromLegacyTiers(
    DEFAULT_COMMISSION_TIERS.map((t, i) => ({ ...t, minYtdSales: t.minYtdSales, sortOrder: i })),
  );

  it("designer crossed $750k mid-period: $700k -> $1.2M = $21,500", () => {
    // Matches __tests__/commissionTiers.test.ts's worked example exactly.
    // basisAtEnd is ALWAYS a live recompute over every given row dated
    // before periodEndExclusive (mirrors production: loadDesignerSaleRows
    // always fetches the full YTD-to-date range) — so the $700k prior
    // position must show up as an actual (pre-period-dated) row here, not
    // be assumed from priorState.basisAtEnd. priorState still supplies the
    // FROZEN basisAtStart, which is what actually matters for the chain-
    // continuity guarantee (a late return dated inside period 1 wouldn't
    // change this $700k figure, only the live rows would).
    const result = computeRuleEnginePayout(
      baseInput({
        rules: [legacyRule],
        priorState: [
          { ruleKey: LEGACY_RULE_KEY, basisAtEnd: 700_000, cumulativeRecognizedCommission: 0 },
        ],
        saleRows: [
          row({ revenue: 700_000, occurredAt: new Date("2026-03-01T00:00:00Z") }), // pre-period
          row({ revenue: 500_000 }), // in-period (default occurredAt)
        ],
      }),
    );
    expect(result.commissionAmount).toBe(21_500);
    expect(
      result.breakdown.map((b) => ({
        label: b.tierLabel,
        slice: b.sliceAmount,
        comm: b.sliceCommission,
      })),
    ).toEqual([
      { label: "Up to $750k", slice: 50_000, comm: 1_500 },
      { label: "$750k – $1M", slice: 250_000, comm: 10_000 },
      { label: "$1M – $1.5M", slice: 200_000, comm: 10_000 },
    ]);
  });

  it("no prior lock -> ytdAtStart falls back to a live sum of pre-period rows", () => {
    const result = computeRuleEnginePayout(
      baseInput({
        rules: [legacyRule],
        priorState: [], // first-ever period
        saleRows: [
          row({ revenue: 200_000, occurredAt: new Date("2026-03-15T00:00:00Z") }), // pre-period
          row({ revenue: 100_000, occurredAt: new Date("2026-05-20T00:00:00Z") }), // in-period
        ],
      }),
    );
    // ytdAtStart = 200k (live pre-period sum), ytdAtEnd = 300k, all in tier 1 (3%).
    expect(result.commissionAmount).toBe(3_000);
    expect(result.nextState).toEqual([
      { ruleKey: LEGACY_RULE_KEY, basisAtEnd: 300_000, cumulativeRecognizedCommission: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Golden-path regression: OLD tier shape vs NEW engine must match exactly.
// This is the test that makes the refactor trustworthy.
// ---------------------------------------------------------------------------

describe("golden-path equivalence: legacy calculateMarginalCommission vs the rule engine", () => {
  const cases: Array<{ name: string; start: number; end: number }> = [
    { name: "single tier, entirely inside tier 1", start: 0, end: 500_000 },
    { name: "single tier, entirely inside top tier", start: 3_000_000, end: 3_500_000 },
    { name: "crosses one boundary", start: 800_000, end: 1_050_000 },
    { name: "crosses three boundaries", start: 700_000, end: 1_600_000 },
    { name: "from $0 through all five tiers", start: 0, end: 2_500_000 },
    { name: "shrinking YTD (returns) -> $0", start: 800_000, end: 750_000 },
    { name: "zero-sales window", start: 500_000, end: 500_000 },
  ];

  const legacyTiers = DEFAULT_COMMISSION_TIERS.map((t, i) => ({ ...t, sortOrder: i }));
  const legacyRule = deriveRuleFromLegacyTiers(legacyTiers);

  it.each(cases)("$name: ytdAtStart=$start, ytdAtEnd=$end", ({ start, end }) => {
    const old = calculateMarginalCommission(start, end, legacyTiers);

    // basisAtEnd is always a live recompute over the given rows (mirrors
    // production's loadDesignerSaleRows always fetching the full YTD-to-
    // date range) — so a nonzero `start` position needs an actual
    // pre-period-dated row, and the in-period delta (which may be
    // NEGATIVE, e.g. the "shrinking YTD" case below — a return) needs its
    // own row rather than being clamped to zero.
    const delta = end - start;
    const saleRows = [];
    if (start !== 0) {
      saleRows.push(row({ revenue: start, occurredAt: new Date("2026-01-15T00:00:00Z") }));
    }
    if (delta !== 0) saleRows.push(row({ revenue: delta }));

    const newResult = computeRuleEnginePayout(
      baseInput({
        rules: [legacyRule],
        priorState:
          start === 0
            ? []
            : [{ ruleKey: LEGACY_RULE_KEY, basisAtEnd: start, cumulativeRecognizedCommission: 0 }],
        saleRows,
      }),
    );

    // Dollar-for-dollar equivalence — the property that matters most.
    expect(newResult.commissionAmount).toBe(old.commission);

    // Shape equivalence: same tiers, same order, same numbers, projected
    // down to the fields the OLD breakdown shape has (the new engine's
    // entries are a strict superset — see docs/domains/commission.md
    // "Snapshot — old and new shapes" for why extra fields are additive,
    // not a shape break, for a migrated legacy plan's UI/audit trail).
    const projected = newResult.breakdown.map((b) => ({
      tierLabel: b.tierLabel,
      rate: b.rate,
      salesInTier: b.sliceAmount,
      commission: b.sliceCommission,
    }));
    expect(projected).toEqual(old.breakdown);
  });
});

// ---------------------------------------------------------------------------
// Per-department differing rates (scope matching)
// ---------------------------------------------------------------------------

describe("per-department differing rates", () => {
  const rules: CommissionRuleDef[] = [
    flatRule({
      ruleKey: "rugs",
      label: "Rugs 10%",
      sortOrder: 0,
      scope: { departmentId: 1 },
      scopeDescription: "Department: Rugs",
      tiers: [
        {
          label: "10%",
          minAmount: 0,
          maxAmountExclusive: null,
          rate: 0.1,
          perUnitAmount: null,
          sortOrder: 0,
        },
      ],
    }),
    flatRule({
      ruleKey: "catchall",
      label: "Everything else 3%",
      sortOrder: 1,
      scope: {},
      scopeDescription: "All sales",
      tiers: [
        {
          label: "3%",
          minAmount: 0,
          maxAmountExclusive: null,
          rate: 0.03,
          perUnitAmount: null,
          sortOrder: 0,
        },
      ],
    }),
  ];

  it("rugs sale earns 10%, everything else earns 3%", () => {
    const result = computeRuleEnginePayout(
      baseInput({
        rules,
        saleRows: [
          row({ revenue: 10_000, departmentId: 1 }),
          row({ revenue: 20_000, departmentId: 2 }),
        ],
      }),
    );
    // 10,000 * 10% = 1,000; 20,000 * 3% = 600. Total 1,600.
    expect(result.commissionAmount).toBe(1_600);
    const byRule = Object.fromEntries(result.breakdown.map((b) => [b.ruleKey, b.sliceCommission]));
    expect(byRule.rugs).toBe(1_000);
    expect(byRule.catchall).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// MARGIN basis
// ---------------------------------------------------------------------------

describe("MARGIN basis", () => {
  it("20% of margin, not revenue", () => {
    const rule = flatRule({
      basis: "MARGIN",
      tiers: [
        {
          label: "20%",
          minAmount: 0,
          maxAmountExclusive: null,
          rate: 0.2,
          perUnitAmount: null,
          sortOrder: 0,
        },
      ],
    });
    const result = computeRuleEnginePayout(
      baseInput({ rules: [rule], saleRows: [row({ revenue: 1_000, margin: 400 })] }),
    );
    expect(result.commissionAmount).toBe(80); // 400 * 20%, NOT 1000 * 20%
  });
});

// ---------------------------------------------------------------------------
// UNITS basis with a flat per-unit amount
// ---------------------------------------------------------------------------

describe("UNITS basis with flat per-unit amount", () => {
  it("$5/unit flat -> 10 units = $50", () => {
    const rule = flatRule({
      basis: "UNITS",
      tiers: [
        {
          label: "$5/unit",
          minAmount: 0,
          maxAmountExclusive: null,
          rate: null,
          perUnitAmount: 5,
          sortOrder: 0,
        },
      ],
    });
    const result = computeRuleEnginePayout(
      baseInput({ rules: [rule], saleRows: [row({ revenue: 999_999, units: 10 })] }),
    );
    expect(result.commissionAmount).toBe(50);
  });

  it("multi-band per-unit: 50 units @ $2 + 30 units @ $3 = $190", () => {
    const rule = flatRule({
      basis: "UNITS",
      accumulator: "YTD",
      tiers: [
        {
          label: "Band A",
          minAmount: 0,
          maxAmountExclusive: 50,
          rate: null,
          perUnitAmount: 2,
          sortOrder: 0,
        },
        {
          label: "Band B",
          minAmount: 50,
          maxAmountExclusive: null,
          rate: null,
          perUnitAmount: 3,
          sortOrder: 1,
        },
      ],
    });
    const result = computeRuleEnginePayout(
      baseInput({ rules: [rule], saleRows: [row({ revenue: 0, units: 80 })] }),
    );
    expect(result.commissionAmount).toBe(190);
  });
});

// ---------------------------------------------------------------------------
// Overlapping-rule precedence (first-match-wins by sortOrder)
// ---------------------------------------------------------------------------

describe("overlapping-rule precedence — first match wins by sortOrder", () => {
  it("a narrower rule ahead of a catch-all claims the sale; the catch-all never sees it", () => {
    const rules: CommissionRuleDef[] = [
      flatRule({ ruleKey: "narrow", sortOrder: 0, scope: { departmentId: 1 } }),
      flatRule({ ruleKey: "catchall", sortOrder: 1, scope: {} }),
    ];
    const result = computeRuleEnginePayout(
      baseInput({ rules, saleRows: [row({ revenue: 10_000, departmentId: 1 })] }),
    );
    const ruleKeys = result.breakdown.map((b) => b.ruleKey);
    expect(ruleKeys).toEqual(["narrow"]);
    expect(ruleKeys).not.toContain("catchall");
  });

  it("reordering sortOrder changes which rule claims the sale", () => {
    // Same two rules, but the catch-all now comes FIRST.
    const rules: CommissionRuleDef[] = [
      flatRule({ ruleKey: "catchall", sortOrder: 0, scope: {} }),
      flatRule({ ruleKey: "narrow", sortOrder: 1, scope: { departmentId: 1 } }),
    ];
    const result = computeRuleEnginePayout(
      baseInput({ rules, saleRows: [row({ revenue: 10_000, departmentId: 1 })] }),
    );
    const ruleKeys = result.breakdown.map((b) => b.ruleKey);
    expect(ruleKeys).toEqual(["catchall"]);
  });

  it("matchRule / scopeMatches directly: null scope fields match anything", () => {
    const r = row({ revenue: 1, departmentId: 7, vendorId: 9 });
    expect(scopeMatches({}, r)).toBe(true);
    expect(scopeMatches({ departmentId: 7 }, r)).toBe(true);
    expect(scopeMatches({ departmentId: 8 }, r)).toBe(false);
    expect(scopeMatches({ departmentId: 7, vendorId: 9 }, r)).toBe(true);
    expect(scopeMatches({ departmentId: 7, vendorId: 1 }, r)).toBe(false);

    const rules = [
      flatRule({ ruleKey: "a", sortOrder: 0, scope: { departmentId: 999 } }),
      flatRule({ ruleKey: "b", sortOrder: 1, scope: {} }),
    ];
    expect(matchRule(r, rules)?.ruleKey).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// A sale matching NO rule — must earn zero, not crash.
// ---------------------------------------------------------------------------

describe("a sale matching no rule", () => {
  it("earns zero and is surfaced in unmatchedAmount, no throw", () => {
    const rule = flatRule({ scope: { departmentId: 1 } });
    const result = computeRuleEnginePayout(
      baseInput({ rules: [rule], saleRows: [row({ revenue: 5_000, departmentId: 2 })] }),
    );
    expect(result.commissionAmount).toBe(0);
    expect(result.breakdown).toEqual([]);
    expect(result.unmatchedAmount).toBe(5_000);
  });

  it("unmatchedAmount only counts rows inside the CURRENT period window", () => {
    const rule = flatRule({ scope: { departmentId: 1 } });
    const result = computeRuleEnginePayout(
      baseInput({
        rules: [rule],
        saleRows: [
          row({ revenue: 5_000, departmentId: 2, occurredAt: new Date("2026-05-20T00:00:00Z") }), // in period
          row({ revenue: 9_000, departmentId: 2, occurredAt: new Date("2026-02-01T00:00:00Z") }), // pre-period
        ],
      }),
    );
    expect(result.unmatchedAmount).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// RETROACTIVE tier mode
// ---------------------------------------------------------------------------

describe("RETROACTIVE tier mode", () => {
  const tiers = [
    {
      label: "Under $750k",
      minAmount: 0,
      maxAmountExclusive: 750_000,
      rate: 0.03,
      perUnitAmount: null,
      sortOrder: 0,
    },
    {
      label: "$750k+",
      minAmount: 750_000,
      maxAmountExclusive: null,
      rate: 0.04,
      perUnitAmount: null,
      sortOrder: 1,
    },
  ];

  it("exactly-at-boundary: $750,000.00 qualifies for the upper band (inclusive lower bound)", () => {
    expect(retroactiveOwedAt(tiers, 750_000)).toBe(30_000); // 4% * 750,000
    expect(retroactiveOwedAt(tiers, 749_999)).toBeCloseTo(22_499.97, 2); // 3% * 749,999
  });

  it("below the lowest tier -> $0 owed (unqualified)", () => {
    // A deferred-goal shape: the lowest tier starts ABOVE $0, so anything
    // under it is genuinely unqualified (see the "PRIMARY deferred path"
    // test below for the full multi-period story).
    const goalTiers = [
      {
        label: "Goal",
        minAmount: 300_000,
        maxAmountExclusive: null,
        rate: 0.1,
        perUnitAmount: null,
        sortOrder: 0,
      },
    ];
    expect(retroactiveOwedAt(goalTiers, 100)).toBe(0);
    expect(tierContaining(goalTiers, 100)).toBeNull();
  });

  it("catch-up spanning a locked prior period: crossing a new band re-rates ALL accumulated dollars, but the earlier period's OWN result is never touched", () => {
    const rule = flatRule({
      ruleKey: "retro",
      tierMode: "RETROACTIVE",
      accumulator: "YTD",
      tiers,
    });

    // basisAtEnd is always a LIVE recompute over every given row (mirrors
    // production's loadDesignerSaleRows always fetching the full YTD range)
    // — so each period's call gets the CUMULATIVE row history, not just
    // that period's own incremental slice. What actually chains between
    // calls is `priorState` (the frozen basisAtStart/cumulativeRecognized
    // carry), not the row list.

    // Period 1 (this would be LOCKED in the real orchestrator): $700k of
    // sales, entirely under the $750k band. Owed = 3% * 700k = $21,000.
    const period1Rows = [row({ revenue: 700_000 })];
    const period1 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: [], saleRows: period1Rows }),
    );
    expect(period1.commissionAmount).toBe(21_000);
    const period1Snapshot = JSON.parse(JSON.stringify(period1));

    // Period 2: another $200k lands, crossing into the $750k+ band. The
    // WHOLE $900k now re-rates at 4% = $36,000 owed; $21,000 was already
    // recognized in period 1, so period 2's NEW commission is the $15,000
    // uplift — attributed entirely to period 2, never rewriting period 1.
    const period2Rows = [...period1Rows, row({ revenue: 200_000 })];
    const period2 = computeRuleEnginePayout(
      baseInput({
        rules: [rule],
        priorState: period1.nextState,
        saleRows: period2Rows,
      }),
    );
    expect(period2.commissionAmount).toBe(15_000);
    expect(period2.breakdown[0]).toMatchObject({
      priorRecognized: 21_000,
      cumulativeRecognizedAfter: 36_000,
      isCatchUp: true, // the SECONDARY case: something was already paid, now bumped
    });

    // Total across both periods matches "4% on the full $900k" exactly —
    // the retroactive property holds in aggregate without ever mutating
    // period 1.
    expect(period1.commissionAmount + period2.commissionAmount).toBe(36_000);

    // Proof period 1's own result was never mutated by computing period 2.
    expect(period1).toEqual(period1Snapshot);

    // Re-running period 1's exact computation again independently gives the
    // identical result — deterministic, no hidden shared state.
    const period1Rerun = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: [], saleRows: period1Rows }),
    );
    expect(period1Rerun).toEqual(period1Snapshot);
  });

  it("PRIMARY deferred path (band starts above $0): nothing recognized before qualification, so isCatchUp is FALSE when it finally qualifies", () => {
    const goalTiers = [
      {
        label: "Goal reached",
        minAmount: 300_000,
        maxAmountExclusive: null,
        rate: 0.1,
        perUnitAmount: null,
        sortOrder: 0,
      },
    ];
    const rule = flatRule({
      ruleKey: "goal-retro",
      tierMode: "RETROACTIVE",
      accumulator: "YTD",
      tiers: goalTiers,
    });

    const period1Rows = [row({ revenue: 100_000 })];
    const period1 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: [], saleRows: period1Rows }),
    );
    expect(period1.commissionAmount).toBe(0); // deferred — below goal, nothing paid
    const period1Snapshot = JSON.parse(JSON.stringify(period1));

    const period2Rows = [...period1Rows, row({ revenue: 150_000 })];
    const period2 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: period1.nextState, saleRows: period2Rows }),
    );
    expect(period2.commissionAmount).toBe(0); // still under $300k (100k + 150k = 250k)
    const period2Snapshot = JSON.parse(JSON.stringify(period2));

    const period3Rows = [...period2Rows, row({ revenue: 100_000 })];
    const period3 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: period2.nextState, saleRows: period3Rows }),
    );
    // 250k + 100k = 350k crosses the $300k goal. RETROACTIVE = retroactive
    // SCOPE: ALL $350k of qualifying YTD sales recognize at once, in the
    // period where qualification happened.
    expect(period3.commissionAmount).toBe(35_000); // 10% * 350,000
    expect(period3.breakdown[0]).toMatchObject({ priorRecognized: 0, isCatchUp: false });

    // Periods 1 and 2 are untouched — no prior "payout" was written to.
    expect(period1).toEqual(period1Snapshot);
    expect(period2).toEqual(period2Snapshot);
  });
});

// ---------------------------------------------------------------------------
// THRESHOLD tier mode
// ---------------------------------------------------------------------------

describe("THRESHOLD tier mode", () => {
  const goalTiers = [
    {
      label: "Above goal",
      minAmount: 300_000,
      maxAmountExclusive: null,
      rate: 0.1,
      perUnitAmount: null,
      sortOrder: 0,
    },
  ];

  it("never met across every period: zero commission every time, no adjustments, no crash", () => {
    const rule = flatRule({
      ruleKey: "goal",
      tierMode: "THRESHOLD",
      accumulator: "YTD",
      tiers: goalTiers,
    });

    const period1Rows = [row({ revenue: 50_000 })];
    const period1 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: [], saleRows: period1Rows }),
    );
    expect(period1.commissionAmount).toBe(0);
    expect(period1.breakdown).toEqual([]);

    const period2Rows = [...period1Rows, row({ revenue: 40_000 })];
    const period2 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: period1.nextState, saleRows: period2Rows }),
    );
    expect(period2.commissionAmount).toBe(0);
    expect(period2.breakdown).toEqual([]);
    // 50k + 40k = 90k, nowhere near the $300k goal — clean zero, not an error.
    expect(period2.nextState).toEqual([
      { ruleKey: "goal", basisAtEnd: 90_000, cumulativeRecognizedCommission: 0 },
    ]);
  });

  it("PROSPECTIVE scope: qualifying in period 3 pays only the excess ABOVE the goal, not the whole YTD", () => {
    const rule = flatRule({
      ruleKey: "goal-threshold",
      tierMode: "THRESHOLD",
      accumulator: "YTD",
      tiers: goalTiers,
    });

    const period1Rows = [row({ revenue: 100_000 })];
    const period1 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: [], saleRows: period1Rows }),
    );
    expect(period1.commissionAmount).toBe(0);
    const period1Snapshot = JSON.parse(JSON.stringify(period1));

    const period2Rows = [...period1Rows, row({ revenue: 150_000 })];
    const period2 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: period1.nextState, saleRows: period2Rows }),
    );
    expect(period2.commissionAmount).toBe(0); // 250k, still under goal
    const period2Snapshot = JSON.parse(JSON.stringify(period2));

    const period3Rows = [...period2Rows, row({ revenue: 100_000 })];
    const period3 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: period2.nextState, saleRows: period3Rows }),
    );
    // 250k -> 350k crosses $300k mid-period. THRESHOLD = prospective scope:
    // only the $50k ABOVE the goal earns (350k - 300k), at 10% = $5,000.
    // The $250k that got them TO the goal, and the first $50k of period 3
    // that crossed them INTO it, stay unpaid — "merely counted toward
    // qualifying."
    expect(period3.commissionAmount).toBe(5_000);
    expect(period3.breakdown[0]).toMatchObject({ sliceAmount: 50_000, sliceCommission: 5_000 });

    // Periods 1 and 2 are untouched.
    expect(period1).toEqual(period1Snapshot);
    expect(period2).toEqual(period2Snapshot);

    // Total: 0 + 0 + 5,000 = 5,000 — sharply less than RETROACTIVE's 35,000
    // on the identical sales history, which is exactly the "it depends on
    // the company" distinction the two tier modes exist to express.
    expect(period1.commissionAmount + period2.commissionAmount + period3.commissionAmount).toBe(
      5_000,
    );
  });
});

// ---------------------------------------------------------------------------
// accumulator = PERIOD (resets every pay period, no YTD carry)
// ---------------------------------------------------------------------------

describe("accumulator = PERIOD", () => {
  it("each period is its own goal window — a hot period doesn't inflate a cold one", () => {
    const rule = flatRule({
      accumulator: "PERIOD",
      tierMode: "THRESHOLD",
      tiers: [
        {
          label: "Above $50k/period",
          minAmount: 50_000,
          maxAmountExclusive: null,
          rate: 0.05,
          perUnitAmount: null,
          sortOrder: 0,
        },
      ],
    });
    const period1 = computeRuleEnginePayout(
      baseInput({ rules: [rule], priorState: [], saleRows: [row({ revenue: 80_000 })] }),
    );
    // 80k this period alone crosses the $50k/period goal: (80k-50k)*5% = 1,500.
    expect(period1.commissionAmount).toBe(1_500);

    // Even with period1's carry passed in, period 2 resets to zero — a
    // designer's hot period doesn't carry a head start into the next one.
    const period2 = computeRuleEnginePayout(
      baseInput({
        rules: [rule],
        priorState: period1.nextState,
        saleRows: [row({ revenue: 10_000 })],
      }),
    );
    expect(period2.commissionAmount).toBe(0); // 10k alone doesn't reach 50k
  });
});

// ---------------------------------------------------------------------------
// accumulator = PER_TRANSACTION (resets per order, no cross-transaction carry)
// ---------------------------------------------------------------------------

describe("accumulator = PER_TRANSACTION", () => {
  it("a big-ticket order pays its own bumped rate; small orders in the same period don't add up to it", () => {
    const rule = flatRule({
      accumulator: "PER_TRANSACTION",
      tierMode: "MARGINAL",
      tiers: [
        {
          label: "Under $10k/order",
          minAmount: 0,
          maxAmountExclusive: 10_000,
          rate: 0.03,
          perUnitAmount: null,
          sortOrder: 0,
        },
        {
          label: "$10k+/order",
          minAmount: 10_000,
          maxAmountExclusive: null,
          rate: 0.06,
          perUnitAmount: null,
          sortOrder: 1,
        },
      ],
    });
    const result = computeRuleEnginePayout(
      baseInput({
        rules: [rule],
        saleRows: [
          row({ transactionId: "SO-1", revenue: 15_000 }), // one big order
          row({ transactionId: "SO-2", revenue: 3_000 }), // several small ones
          row({ transactionId: "SO-3", revenue: 4_000 }),
        ],
      }),
    );
    // SO-1: 10k @ 3% + 5k @ 6% = 300 + 300 = 600.
    // SO-2: 3k @ 3% = 90. SO-3: 4k @ 3% = 120.
    // Total: 600 + 90 + 120 = 810. NOT the marginal-on-22k-combined figure
    // (which would be 810 too by coincidence at these numbers — use a
    // pointed assertion on the per-order math instead of just the total).
    expect(result.commissionAmount).toBe(810);
  });

  it("RETROACTIVE + PER_TRANSACTION re-rates the whole order, never carries across orders or periods", () => {
    const rule = flatRule({
      accumulator: "PER_TRANSACTION",
      tierMode: "RETROACTIVE",
      tiers: [
        {
          label: "Under $10k",
          minAmount: 0,
          maxAmountExclusive: 10_000,
          rate: 0.03,
          perUnitAmount: null,
          sortOrder: 0,
        },
        {
          label: "$10k+",
          minAmount: 10_000,
          maxAmountExclusive: null,
          rate: 0.06,
          perUnitAmount: null,
          sortOrder: 1,
        },
      ],
    });
    const result = computeRuleEnginePayout(
      baseInput({
        rules: [rule],
        saleRows: [
          row({ transactionId: "BIG", revenue: 20_000 }),
          row({ transactionId: "SMALL", revenue: 1_000 }),
        ],
      }),
    );
    // BIG: whole $20,000 re-rates at 6% = $1,200 (not just the excess over $10k).
    // SMALL: $1,000 * 3% = $30.
    expect(result.commissionAmount).toBe(1_230);
  });
});

// ---------------------------------------------------------------------------
// validateRuleTiers
// ---------------------------------------------------------------------------

describe("validateRuleTiers", () => {
  const ok = [
    {
      label: "A",
      minAmount: 0,
      maxAmountExclusive: 100,
      rate: 0.1,
      perUnitAmount: null,
      sortOrder: 0,
    },
    {
      label: "B",
      minAmount: 100,
      maxAmountExclusive: null,
      rate: 0.2,
      perUnitAmount: null,
      sortOrder: 1,
    },
  ];

  it("valid contiguous tiers pass", () => {
    expect(validateRuleTiers(ok)).toBeNull();
  });

  it("empty tier list is rejected", () => {
    expect(validateRuleTiers([])).toMatch(/at least one tier/);
  });

  it("both rate and perUnitAmount set is rejected", () => {
    const bad = [
      {
        label: "A",
        minAmount: 0,
        maxAmountExclusive: null,
        rate: 0.1,
        perUnitAmount: 5,
        sortOrder: 0,
      },
    ];
    expect(validateRuleTiers(bad)).toMatch(/exactly one of rate or perUnitAmount/);
  });

  it("neither rate nor perUnitAmount set is rejected", () => {
    const bad = [
      {
        label: "A",
        minAmount: 0,
        maxAmountExclusive: null,
        rate: null,
        perUnitAmount: null,
        sortOrder: 0,
      },
    ];
    expect(validateRuleTiers(bad)).toMatch(/exactly one of rate or perUnitAmount/);
  });

  it("non-last unbounded tier is rejected", () => {
    const bad = [
      {
        label: "A",
        minAmount: 0,
        maxAmountExclusive: null,
        rate: 0.1,
        perUnitAmount: null,
        sortOrder: 0,
      },
      {
        label: "B",
        minAmount: 100,
        maxAmountExclusive: null,
        rate: 0.2,
        perUnitAmount: null,
        sortOrder: 1,
      },
    ];
    expect(validateRuleTiers(bad)).toMatch(/only the last tier may be unbounded/);
  });

  it("non-contiguous brackets are rejected", () => {
    const bad = [
      {
        label: "A",
        minAmount: 0,
        maxAmountExclusive: 100,
        rate: 0.1,
        perUnitAmount: null,
        sortOrder: 0,
      },
      {
        label: "B",
        minAmount: 200,
        maxAmountExclusive: null,
        rate: 0.2,
        perUnitAmount: null,
        sortOrder: 1,
      },
    ];
    expect(validateRuleTiers(bad)).toMatch(/contiguous/);
  });

  it("rate out of [0,1] is rejected", () => {
    const bad = [
      {
        label: "A",
        minAmount: 0,
        maxAmountExclusive: null,
        rate: 1.5,
        perUnitAmount: null,
        sortOrder: 0,
      },
    ];
    expect(validateRuleTiers(bad)).toMatch(/rate must be between 0 and 1/);
  });

  it("negative perUnitAmount is rejected", () => {
    const bad = [
      {
        label: "A",
        minAmount: 0,
        maxAmountExclusive: null,
        rate: null,
        perUnitAmount: -1,
        sortOrder: 0,
      },
    ];
    expect(validateRuleTiers(bad)).toMatch(/perUnitAmount must be >= 0/);
  });
});

// ---------------------------------------------------------------------------
// marginalOverlapSum / tierContaining direct coverage
// ---------------------------------------------------------------------------

describe("marginalOverlapSum / tierContaining", () => {
  const tiers = [
    {
      label: "A",
      minAmount: 0,
      maxAmountExclusive: 100,
      rate: 0.1,
      perUnitAmount: null,
      sortOrder: 0,
    },
    {
      label: "B",
      minAmount: 100,
      maxAmountExclusive: null,
      rate: 0.2,
      perUnitAmount: null,
      sortOrder: 1,
    },
  ];

  it("end <= start -> zero, no entries", () => {
    expect(marginalOverlapSum(tiers, 100, 100)).toEqual({ total: 0, entries: [] });
    expect(marginalOverlapSum(tiers, 100, 50)).toEqual({ total: 0, entries: [] });
  });

  it("tierContaining returns null above/below everything correctly", () => {
    expect(tierContaining(tiers, -5)).toBeNull();
    expect(tierContaining(tiers, 0)?.label).toBe("A");
    expect(tierContaining(tiers, 100)?.label).toBe("B");
    expect(tierContaining(tiers, 1_000_000)?.label).toBe("B");
  });
});
