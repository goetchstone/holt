// /app/__tests__/commissionPayout.test.ts
//
// Pure-helper coverage for the commission-payout computer. The math
// engine (calculateMarginalCommission) is already tested in
// commissionTiers.test.ts; here we pin the shape of the
// computePayoutForRange wrapper: tier-breakdown mapping, snapshot
// preservation, periodSalesAmount derivation.

import { computePayoutForRange } from "../src/lib/commissionPayout";
import { DEFAULT_COMMISSION_TIERS } from "../src/lib/commissionTiers";

const tiersWithSortOrder = DEFAULT_COMMISSION_TIERS.map((t, i) => ({ ...t, sortOrder: i }));

describe("computePayoutForRange", () => {
  it("uses marginal math + maps the breakdown to {tierLabel, rate, sliceAmount, sliceCommission}", () => {
    // Designer crossed $750k mid-period:
    //   ytdAtStart = $700,000, ytdAtEnd = $800,000 → $100k of new sales
    //     - $50k below $750k @ 3% = $1,500
    //     - $50k above $750k @ 4% = $2,000
    //   total: $3,500
    const result = computePayoutForRange({
      staffMemberId: 42,
      periodStart: new Date("2026-05-16T00:00:00Z"),
      periodEnd: new Date("2026-05-31T00:00:00Z"),
      ytdSalesAtStart: 700_000,
      ytdSalesAtEnd: 800_000,
      tiers: tiersWithSortOrder,
    });
    expect(result.commissionAmount).toBe(3500);
    expect(result.periodSalesAmount).toBe(100_000);
    expect(result.tierBreakdown).toEqual([
      { tierLabel: "Up to $750k", rate: 0.03, sliceAmount: 50_000, sliceCommission: 1500 },
      { tierLabel: "$750k – $1M", rate: 0.04, sliceAmount: 50_000, sliceCommission: 2000 },
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
      ytdSalesAtEnd: 200_000, // both inside the 3% tier
      tiers: tiersWithSortOrder,
    });
    expect(result.tierBreakdown).toHaveLength(1);
    expect(result.tierBreakdown[0]).toMatchObject({
      tierLabel: "Up to $750k",
      sliceAmount: 100_000,
      sliceCommission: 3000,
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
