// /app/__tests__/commissionTiers.test.ts
//
// Pure tests for the MARGINAL commission-tier calculator. No DB.
//
// Confirmed with owner 2026-05-19: "tiers are not retroactive, once
// you hit X then you get Y going forward." Each tier's rate applies
// only to the slice of YTD sales inside that tier's bracket.

import {
  calculateMarginalCommission,
  resolveTier,
  DEFAULT_COMMISSION_TIERS,
} from "../src/lib/commissionTiers";

describe("resolveTier (current bracket)", () => {
  it("$0 → tier 1 (Up to $750k)", () => {
    expect(resolveTier(0, DEFAULT_COMMISSION_TIERS)?.label).toBe("Up to $750k");
  });

  it("$749,999 → tier 1", () => {
    expect(resolveTier(749_999, DEFAULT_COMMISSION_TIERS)?.label).toBe("Up to $750k");
  });

  it("$750,000 → tier 2 ($750k - $1M) (exact threshold)", () => {
    expect(resolveTier(750_000, DEFAULT_COMMISSION_TIERS)?.label).toBe("$750k – $1M");
  });

  it("$1,000,000 → tier 3 ($1M - $1.5M)", () => {
    expect(resolveTier(1_000_000, DEFAULT_COMMISSION_TIERS)?.label).toBe("$1M – $1.5M");
  });

  it("$10,000,000 → top tier (Over $2M)", () => {
    expect(resolveTier(10_000_000, DEFAULT_COMMISSION_TIERS)?.label).toBe("Over $2M");
  });

  it("negative input clamps to tier 1", () => {
    expect(resolveTier(-500, DEFAULT_COMMISSION_TIERS)?.label).toBe("Up to $750k");
  });
});

describe("calculateMarginalCommission — single-tier windows", () => {
  it("window entirely inside tier 1: 3% × $500k = $15,000", () => {
    const r = calculateMarginalCommission(0, 500_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(15_000);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0]).toEqual({
      tierLabel: "Up to $750k",
      rate: 0.03,
      salesInTier: 500_000,
      commission: 15_000,
    });
  });

  it("window entirely inside tier 2: 4% × $200k = $8,000", () => {
    const r = calculateMarginalCommission(800_000, 1_000_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(8_000);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0].tierLabel).toBe("$750k – $1M");
    expect(r.breakdown[0].salesInTier).toBe(200_000);
  });

  it("window entirely inside top tier: 7% × $500k = $35,000", () => {
    const r = calculateMarginalCommission(3_000_000, 3_500_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(35_000);
    expect(r.breakdown[0].tierLabel).toBe("Over $2M");
  });
});

describe("calculateMarginalCommission — multi-tier windows", () => {
  // Worked example from helper doc:
  //   $800k → $1.05M = $250k slice
  //   Tier 2 ($750k-$1M, 4%): overlap = $200k → $8,000
  //   Tier 3 ($1M-$1.5M, 5%): overlap = $50k → $2,500
  //   Total: $10,500

  it("crosses one boundary: $800k → $1.05M = $10,500", () => {
    const r = calculateMarginalCommission(800_000, 1_050_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(10_500);
    expect(r.breakdown).toEqual([
      { tierLabel: "$750k – $1M", rate: 0.04, salesInTier: 200_000, commission: 8_000 },
      { tierLabel: "$1M – $1.5M", rate: 0.05, salesInTier: 50_000, commission: 2_500 },
    ]);
  });

  it("crosses three boundaries: $700k → $1.6M", () => {
    // $700k-$750k = $50k at 3% = $1,500
    // $750k-$1M = $250k at 4% = $10,000
    // $1M-$1.5M = $500k at 5% = $25,000
    // $1.5M-$1.6M = $100k at 6% = $6,000
    // Total: $42,500
    const r = calculateMarginalCommission(700_000, 1_600_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(42_500);
    expect(r.breakdown).toHaveLength(4);
  });

  it("from $0 to $2.5M: hits all 5 tiers", () => {
    // $0-$750k:      $750k × 3% = $22,500
    // $750k-$1M:     $250k × 4% = $10,000
    // $1M-$1.5M:     $500k × 5% = $25,000
    // $1.5M-$2M:     $500k × 6% = $30,000
    // $2M-$2.5M:     $500k × 7% = $35,000
    // Total: $122,500
    const r = calculateMarginalCommission(0, 2_500_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(122_500);
    expect(r.breakdown).toHaveLength(5);
  });
});

describe("calculateMarginalCommission — period-over-period (the real use case)", () => {
  // Owner's intent: report runs as a DATE RANGE. For each designer we
  // compute ytdAtStart (the day before window begins) and ytdAtEnd
  // (the last day of window). Commission for the window is the
  // marginal slice between those two YTD values.

  it("designer started Q1 with $0, finished Q1 with $300k — all in tier 1", () => {
    const r = calculateMarginalCommission(0, 300_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(9_000);
  });

  it("designer crossed $750k mid-Q2 — first $50k of Q2 at 3%, rest at 4%", () => {
    // Start of Q2: $700k YTD
    // End of Q2: $1.2M YTD ($500k of Q2 sales)
    //   $700k → $750k = $50k × 3% = $1,500
    //   $750k → $1M = $250k × 4% = $10,000
    //   $1M → $1.2M = $200k × 5% = $10,000
    //   Total: $21,500
    const r = calculateMarginalCommission(700_000, 1_200_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(21_500);
  });

  it("top designer already over $2M before window — entire window at 7%", () => {
    // Start: $2.3M, End: $2.55M -> $250k × 7% = $17,500
    const r = calculateMarginalCommission(2_300_000, 2_550_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(17_500);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0].rate).toBe(0.07);
  });
});

describe("calculateMarginalCommission — defensive inputs", () => {
  it("ytdAtEnd <= ytdAtStart → $0 commission (e.g. designer's YTD shrank from returns)", () => {
    const r = calculateMarginalCommission(500_000, 500_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it("ytdAtEnd strictly below ytdAtStart → $0", () => {
    const r = calculateMarginalCommission(500_000, 450_000, DEFAULT_COMMISSION_TIERS);
    expect(r.commission).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it("NaN ytdAtStart → treated as 0 (clean window)", () => {
    // sanitize(NaN) = 0, so (NaN, 100k) becomes the same as (0, 100k) → 3% × 100k
    expect(
      calculateMarginalCommission(Number.NaN, 100_000, DEFAULT_COMMISSION_TIERS).commission,
    ).toBe(3_000);
  });

  it("NaN ytdAtEnd → $0 (defensive: window collapses)", () => {
    expect(
      calculateMarginalCommission(100_000, Number.NaN, DEFAULT_COMMISSION_TIERS).commission,
    ).toBe(0);
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
// commissioned on one employer's 3%-to-7% schedule -- and runCommissionPayouts
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
    // Saybrook's numbers must not move. Same inputs, same output as before.
    const result = calculateMarginalCommission(0, 1_000_000, DEFAULT_COMMISSION_TIERS);
    expect(result.commission).toBeGreaterThan(0);
    expect(resolveTier(1_000_000, DEFAULT_COMMISSION_TIERS)?.label).toBe("$1M – $1.5M");
  });
});
