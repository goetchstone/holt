// /app/__tests__/commissionPayout.test.ts
//
// Pure-helper coverage for the commission-payout computer. The math
// engine (calculateMarginalCommission) is already tested in
// commissionTiers.test.ts; here we pin the shape of the
// computePayoutForRange wrapper: tier-breakdown mapping, snapshot
// preservation, periodSalesAmount derivation.

import { computePayoutForRange } from "../src/lib/commissionPayout";

// An invented 2%-to-6% schedule: the wrapper's shape is what is under test,
// so any contiguous brackets serve.
const tiersWithSortOrder = [
  { minYtdSales: 0, maxYtdSalesExclusive: 500_000, rate: 0.02, label: "Up to $500k" },
  { minYtdSales: 500_000, maxYtdSalesExclusive: 800_000, rate: 0.03, label: "$500k – $800k" },
  { minYtdSales: 800_000, maxYtdSalesExclusive: 1_200_000, rate: 0.04, label: "$800k – $1.2M" },
  { minYtdSales: 1_200_000, maxYtdSalesExclusive: 1_600_000, rate: 0.05, label: "$1.2M – $1.6M" },
  { minYtdSales: 1_600_000, maxYtdSalesExclusive: null, rate: 0.06, label: "Over $1.6M" },
].map((t, i) => ({ ...t, sortOrder: i }));

describe("computePayoutForRange", () => {
  it("uses marginal math + maps the breakdown to {tierLabel, rate, sliceAmount, sliceCommission}", () => {
    // Designer crossed $500k mid-period:
    //   ytdAtStart = $450,000, ytdAtEnd = $550,000 → $100k of new sales
    //     - $50k below $500k @ 2% = $1,000
    //     - $50k above $500k @ 3% = $1,500
    //   total: $2,500
    const result = computePayoutForRange({
      staffMemberId: 42,
      periodStart: new Date("2026-05-16T00:00:00Z"),
      periodEnd: new Date("2026-05-31T00:00:00Z"),
      ytdSalesAtStart: 450_000,
      ytdSalesAtEnd: 550_000,
      tiers: tiersWithSortOrder,
    });
    expect(result.commissionAmount).toBe(2500);
    expect(result.periodSalesAmount).toBe(100_000);
    expect(result.tierBreakdown).toEqual([
      { tierLabel: "Up to $500k", rate: 0.02, sliceAmount: 50_000, sliceCommission: 1000 },
      { tierLabel: "$500k – $800k", rate: 0.03, sliceAmount: 50_000, sliceCommission: 1500 },
    ]);
  });

  it("captures a tier-definition snapshot so retroactive tier edits don't rewrite history", () => {
    const customTiers = [
      { label: "Custom A", minYtdSales: 0, maxYtdSalesExclusive: 100_000, rate: 0.1, sortOrder: 0 },
      {
        label: "Custom B",
        minYtdSales: 100_000,
        maxYtdSalesExclusive: null,
        rate: 0.2,
        sortOrder: 1,
      },
    ];
    const result = computePayoutForRange({
      staffMemberId: 1,
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-01-31T00:00:00Z"),
      ytdSalesAtStart: 0,
      ytdSalesAtEnd: 50_000,
      tiers: customTiers,
    });
    expect(result.tierDefinitionSnapshot).toEqual([
      { label: "Custom A", minYtdSales: 0, maxYtdSalesExclusive: 100_000, rate: 0.1, sortOrder: 0 },
      {
        label: "Custom B",
        minYtdSales: 100_000,
        maxYtdSalesExclusive: null,
        rate: 0.2,
        sortOrder: 1,
      },
    ]);
  });

  it("clamps a negative slice (returns shrinking YTD) to zero commission + zero breakdown", () => {
    // Designer's YTD shrank in the period (heavy returns).
    const result = computePayoutForRange({
      staffMemberId: 1,
      periodStart: new Date("2026-05-01T00:00:00Z"),
      periodEnd: new Date("2026-05-15T00:00:00Z"),
      ytdSalesAtStart: 800_000,
      ytdSalesAtEnd: 750_000, // shrank by $50k
      tiers: tiersWithSortOrder,
    });
    expect(result.commissionAmount).toBe(0);
    expect(result.tierBreakdown).toEqual([]);
    expect(result.periodSalesAmount).toBe(0); // clamped to 0, not -50k
  });

  it("zero-sales period: 0 commission, empty breakdown, periodSales = 0", () => {
    const result = computePayoutForRange({
      staffMemberId: 1,
      periodStart: new Date("2026-05-01T00:00:00Z"),
      periodEnd: new Date("2026-05-15T00:00:00Z"),
      ytdSalesAtStart: 500_000,
      ytdSalesAtEnd: 500_000,
      tiers: tiersWithSortOrder,
    });
    expect(result.commissionAmount).toBe(0);
    expect(result.periodSalesAmount).toBe(0);
    expect(result.tierBreakdown).toEqual([]);
  });

  it("single-tier slice: breakdown has exactly one entry", () => {
    const result = computePayoutForRange({
      staffMemberId: 1,
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-01-15T00:00:00Z"),
      ytdSalesAtStart: 100_000,
      ytdSalesAtEnd: 200_000, // both inside the 2% tier
      tiers: tiersWithSortOrder,
    });
    expect(result.tierBreakdown).toHaveLength(1);
    expect(result.tierBreakdown[0]).toMatchObject({
      tierLabel: "Up to $500k",
      sliceAmount: 100_000,
      sliceCommission: 2000,
    });
  });

  it("preserves the period dates verbatim — caller-supplied Y/M/D round-trips", () => {
    const start = new Date("2026-05-16T00:00:00Z");
    const end = new Date("2026-05-31T00:00:00Z");
    const result = computePayoutForRange({
      staffMemberId: 1,
      periodStart: start,
      periodEnd: end,
      ytdSalesAtStart: 0,
      ytdSalesAtEnd: 0,
      tiers: tiersWithSortOrder,
    });
    expect(result.periodStart.getTime()).toBe(start.getTime());
    expect(result.periodEnd.getTime()).toBe(end.getTime());
  });
});
