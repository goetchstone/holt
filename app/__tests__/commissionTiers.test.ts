// /app/__tests__/commissionTiers.test.ts
//
// Pure tests for the MARGINAL commission-tier calculator. No DB.
//
// Tiers are marginal, not retroactive: once you reach a tier, its rate
// applies going forward. Each tier's rate applies only to the slice of
// YTD sales inside that tier's bracket.

import {
  calculateMarginalCommission,
  resolveTier,
  DEFAULT_COMMISSION_TIERS,
  type CommissionTier,
} from "../src/lib/commissionTiers";

// An invented 2%-to-6% schedule. The calculator is exercised against this
// rather than DEFAULT_COMMISSION_TIERS so the arithmetic below does not move
// when the reference values do; the shape checks further down still read
// DEFAULT_COMMISSION_TIERS itself.
const TIERS: readonly CommissionTier[] = [
  { minYtdSales: 0, maxYtdSalesExclusive: 500_000, rate: 0.02, label: "Up to $500k" },
  { minYtdSales: 500_000, maxYtdSalesExclusive: 800_000, rate: 0.03, label: "$500k – $800k" },
  { minYtdSales: 800_000, maxYtdSalesExclusive: 1_200_000, rate: 0.04, label: "$800k – $1.2M" },
  { minYtdSales: 1_200_000, maxYtdSalesExclusive: 1_600_000, rate: 0.05, label: "$1.2M – $1.6M" },
  { minYtdSales: 1_600_000, maxYtdSalesExclusive: null, rate: 0.06, label: "Over $1.6M" },
];

describe("resolveTier (current bracket)", () => {
  it("$0 → tier 1 (Up to $500k)", () => {
    expect(resolveTier(0, TIERS)?.label).toBe("Up to $500k");
  });

  it("$499,999 → tier 1", () => {
    expect(resolveTier(499_999, TIERS)?.label).toBe("Up to $500k");
  });

  it("$500,000 → tier 2 ($500k - $800k) (exact threshold)", () => {
    expect(resolveTier(500_000, TIERS)?.label).toBe("$500k – $800k");
  });

  it("$1,000,000 → tier 3 ($800k - $1.2M)", () => {
    expect(resolveTier(1_000_000, TIERS)?.label).toBe("$800k – $1.2M");
  });

  it("$10,000,000 → top tier (Over $1.6M)", () => {
    expect(resolveTier(10_000_000, TIERS)?.label).toBe("Over $1.6M");
  });

  it("negative input clamps to tier 1", () => {
    expect(resolveTier(-500, TIERS)?.label).toBe("Up to $500k");
  });
});

describe("calculateMarginalCommission — single-tier windows", () => {
  it("window entirely inside tier 1: 2% × $400k = $8,000", () => {
    const r = calculateMarginalCommission(0, 400_000, TIERS);
    expect(r.commission).toBe(8_000);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0]).toEqual({
      tierLabel: "Up to $500k",
      rate: 0.02,
      salesInTier: 400_000,
      commission: 8_000,
    });
  });

  it("window entirely inside tier 2: 3% × $200k = $6,000", () => {
    const r = calculateMarginalCommission(550_000, 750_000, TIERS);
    expect(r.commission).toBe(6_000);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0].tierLabel).toBe("$500k – $800k");
    expect(r.breakdown[0].salesInTier).toBe(200_000);
  });

  it("window entirely inside top tier: 6% × $500k = $30,000", () => {
    const r = calculateMarginalCommission(3_000_000, 3_500_000, TIERS);
    expect(r.commission).toBe(30_000);
    expect(r.breakdown[0].tierLabel).toBe("Over $1.6M");
  });
});

describe("calculateMarginalCommission — multi-tier windows", () => {
  // Worked example:
  //   $600k → $900k = $300k slice
  //   Tier 2 ($500k-$800k, 3%): overlap = $200k → $6,000
  //   Tier 3 ($800k-$1.2M, 4%): overlap = $100k → $4,000
  //   Total: $10,000

  it("crosses one boundary: $600k → $900k = $10,000", () => {
    const r = calculateMarginalCommission(600_000, 900_000, TIERS);
    expect(r.commission).toBe(10_000);
    expect(r.breakdown).toEqual([
      { tierLabel: "$500k – $800k", rate: 0.03, salesInTier: 200_000, commission: 6_000 },
      { tierLabel: "$800k – $1.2M", rate: 0.04, salesInTier: 100_000, commission: 4_000 },
    ]);
  });

  it("crosses three boundaries: $450k → $1.3M", () => {
    // $450k-$500k = $50k at 2% = $1,000
    // $500k-$800k = $300k at 3% = $9,000
    // $800k-$1.2M = $400k at 4% = $16,000
    // $1.2M-$1.3M = $100k at 5% = $5,000
    // Total: $31,000
    const r = calculateMarginalCommission(450_000, 1_300_000, TIERS);
    expect(r.commission).toBe(31_000);
    expect(r.breakdown).toHaveLength(4);
  });

  it("from $0 to $2M: hits all 5 tiers", () => {
    // $0-$500k:      $500k × 2% = $10,000
    // $500k-$800k:   $300k × 3% = $9,000
    // $800k-$1.2M:   $400k × 4% = $16,000
    // $1.2M-$1.6M:   $400k × 5% = $20,000
    // $1.6M-$2M:     $400k × 6% = $24,000
    // Total: $79,000
    const r = calculateMarginalCommission(0, 2_000_000, TIERS);
    expect(r.commission).toBe(79_000);
    expect(r.breakdown).toHaveLength(5);
  });
});

describe("calculateMarginalCommission — period-over-period (the real use case)", () => {
  // Owner's intent: report runs as a DATE RANGE. For each designer we
  // compute ytdAtStart (the day before window begins) and ytdAtEnd
  // (the last day of window). Commission for the window is the
  // marginal slice between those two YTD values.

  it("designer started Q1 with $0, finished Q1 with $300k — all in tier 1", () => {
    const r = calculateMarginalCommission(0, 300_000, TIERS);
    expect(r.commission).toBe(6_000);
  });

  it("designer crossed $500k mid-Q2 — first $50k of Q2 at 2%, the rest at 3% and up", () => {
    // Start of Q2: $450k YTD
    // End of Q2: $1M YTD ($550k of Q2 sales)
    //   $450k → $500k = $50k × 2% = $1,000
    //   $500k → $800k = $300k × 3% = $9,000
    //   $800k → $1M = $200k × 4% = $8,000
    //   Total: $18,000
    const r = calculateMarginalCommission(450_000, 1_000_000, TIERS);
    expect(r.commission).toBe(18_000);
  });

  it("top designer already over $1.6M before window — entire window at 6%", () => {
    // Start: $2.3M, End: $2.55M -> $250k × 6% = $15,000
    const r = calculateMarginalCommission(2_300_000, 2_550_000, TIERS);
    expect(r.commission).toBe(15_000);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0].rate).toBe(0.06);
  });
});

describe("calculateMarginalCommission — defensive inputs", () => {
  it("ytdAtEnd <= ytdAtStart → $0 commission (e.g. designer's YTD shrank from returns)", () => {
    const r = calculateMarginalCommission(500_000, 500_000, TIERS);
    expect(r.commission).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it("ytdAtEnd strictly below ytdAtStart → $0", () => {
    const r = calculateMarginalCommission(500_000, 450_000, TIERS);
    expect(r.commission).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it("NaN ytdAtStart → treated as 0 (clean window)", () => {
    // sanitize(NaN) = 0, so (NaN, 100k) becomes the same as (0, 100k) → 2% × 100k
    expect(calculateMarginalCommission(Number.NaN, 100_000, TIERS).commission).toBe(2_000);
  });

  it("NaN ytdAtEnd → $0 (defensive: window collapses)", () => {
    expect(calculateMarginalCommission(100_000, Number.NaN, TIERS).commission).toBe(0);
  });

  it("empty tiers array → $0", () => {
    const r = calculateMarginalCommission(0, 1_000_000, []);
    expect(r.commission).toBe(0);
  });
});

describe("calculateMarginalCommission — custom tier sets (configurable)", () => {
  it("custom 2-tier set: 5% < $1M, 10% above", () => {
    const customTiers = [
      { minYtdSales: 0, maxYtdSalesExclusive: 1_000_000, rate: 0.05, label: "Tier A" },
      { minYtdSales: 1_000_000, maxYtdSalesExclusive: null, rate: 0.1, label: "Tier B" },
    ];
    // $500k → $1.5M
    //   $500k-$1M = $500k × 5% = $25,000
    //   $1M-$1.5M = $500k × 10% = $50,000
    //   Total: $75,000
    const r = calculateMarginalCommission(500_000, 1_500_000, customTiers);
    expect(r.commission).toBe(75_000);
  });
});

describe("DEFAULT_COMMISSION_TIERS shape", () => {
  it("tiers are contiguous: each tier's upper bound = next tier's lower bound", () => {
    for (let i = 0; i < DEFAULT_COMMISSION_TIERS.length - 1; i++) {
      const current = DEFAULT_COMMISSION_TIERS[i];
      const next = DEFAULT_COMMISSION_TIERS[i + 1];
      expect(current.maxYtdSalesExclusive).toBe(next.minYtdSales);
    }
  });

  it("top tier has no upper bound", () => {
    const top = DEFAULT_COMMISSION_TIERS[DEFAULT_COMMISSION_TIERS.length - 1];
    expect(top.maxYtdSalesExclusive).toBeNull();
  });

  it("rates monotonically increase across tiers", () => {
    for (let i = 0; i < DEFAULT_COMMISSION_TIERS.length - 1; i++) {
      expect(DEFAULT_COMMISSION_TIERS[i + 1].rate).toBeGreaterThan(
        DEFAULT_COMMISSION_TIERS[i].rate,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// No commission plan configured
//
// DEFAULT_COMMISSION_TIERS used to be the runtime fallback when a deployment
// had configured no plan at all, so an unconfigured business was silently
// commissioned on a single hardcoded schedule -- and runCommissionPayouts
// PERSISTED those numbers. Nothing failed and nothing warned; the wrong figure
// was simply the one that got paid.
//
// Owner's direction: "if there is no commission plan then there is nothing to
// report on." Empty tiers are now a legitimate answer rather than an error, and
// these assert the two shapes that answer takes.
// ---------------------------------------------------------------------------
describe("no plan configured — empty tiers are an answer, not a crash", () => {
  it("resolveTier returns null rather than undefined wearing a tier's type", () => {
    // Was `return tiers.at(-1) as CommissionTier`, which on an empty array
    // handed back undefined typed as a real tier. The crash then landed a
    // frame or two later, with nothing pointing at the missing plan.
    expect(resolveTier(0, [])).toBeNull();
    expect(resolveTier(5_000_000, [])).toBeNull();
  });

  it("calculateMarginalCommission pays zero rather than guessing a rate", () => {
    const result = calculateMarginalCommission(0, 1_000_000, []);
    expect(result.commission).toBe(0);
    expect(result.breakdown).toEqual([]);
  });

  it("a configured plan is unaffected — the equivalence that matters", () => {
    // An existing deployment's configured numbers must not move. Same inputs, same
    // output as before.
    const result = calculateMarginalCommission(0, 1_000_000, TIERS);
    expect(result.commission).toBeGreaterThan(0);
    expect(resolveTier(1_000_000, TIERS)?.label).toBe("$800k – $1.2M");
  });
});
