// /app/__tests__/marginMath.test.ts
//
// A-grade pure-helper tests for the margin math used by the
// sales-by-salesperson report. No I/O, no mocks. Asserts the
// invariants the report depends on:
//   - retail / cost sum correctly
//   - margin = retail - cost (within penny tolerance)
//   - margin% is NaN-safe at retail=0
//   - split attribution halves both retail AND cost (margin% preserved)
//   - itemCount matches the Detailed Sales convention (positive-retail lines)

import {
  aggregateMargin,
  applyShare,
  formatMarginPct,
  imputeMissingCost,
} from "../src/lib/marginMath";

describe("aggregateMargin", () => {
  it("returns zero row for empty input", () => {
    const r = aggregateMargin([]);
    expect(r.retail).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.margin).toBe(0);
    expect(r.marginPct).toBe(0);
    expect(r.itemCount).toBe(0);
  });

  it("sums retail and cost, computes margin and margin%", () => {
    const r = aggregateMargin([
      { retail: 1000, cost: 400 },
      { retail: 500, cost: 300 },
    ]);
    expect(r.retail).toBe(1500);
    expect(r.cost).toBe(700);
    expect(r.margin).toBe(800);
    // 800 / 1500 = 0.5333...
    expect(r.marginPct).toBeCloseTo(0.5333, 4);
    expect(r.itemCount).toBe(2);
  });

  it("returns marginPct = 0 when retail is 0 (NaN-safe)", () => {
    const r = aggregateMargin([{ retail: 0, cost: 0 }]);
    expect(r.retail).toBe(0);
    expect(r.marginPct).toBe(0);
    expect(Number.isNaN(r.marginPct)).toBe(false);
    expect(Number.isFinite(r.marginPct)).toBe(true);
  });

  it("returns marginPct = 0 when retail is 0 but cost is non-zero (line was zeroed-out)", () => {
    // Edge case: refund or returned line where retail went to 0 but
    // cost remained -- protects against Infinity from cost/0.
    const r = aggregateMargin([{ retail: 0, cost: 50 }]);
    expect(r.marginPct).toBe(0);
    expect(Number.isFinite(r.marginPct)).toBe(true);
  });

  it("handles negative retail (return-day shape)", () => {
    // A return: retail and cost both negative, margin is also negative
    const r = aggregateMargin([{ retail: -1000, cost: -400 }]);
    expect(r.retail).toBe(-1000);
    expect(r.cost).toBe(-400);
    expect(r.margin).toBe(-600);
    // -600 / -1000 = 0.6 (60% margin) -- the same margin% the original
    // sale would have had. Returns don't distort the salesperson's
    // margin signal; they just reduce the totals.
    expect(r.marginPct).toBeCloseTo(0.6, 4);
    // Only positive-retail lines count toward itemCount, so a refund-only
    // line gives itemCount=0 (matches Detailed Sales convention).
    expect(r.itemCount).toBe(0);
  });

  it("counts only positive-retail lines toward itemCount", () => {
    const r = aggregateMargin([
      { retail: 100, cost: 40 },
      { retail: 0, cost: 0 }, // skipped — zero retail
      { retail: -50, cost: -20 }, // skipped — negative retail
      { retail: 200, cost: 80 },
    ]);
    expect(r.itemCount).toBe(2);
    expect(r.retail).toBe(250); // 100 + 0 - 50 + 200
    expect(r.cost).toBe(100); // 40 + 0 - 20 + 80
  });

  it("rounds totals to 2 decimal places after summing (avoids float drift)", () => {
    // 0.1 + 0.2 + 0.3 + ... summed many times can drift in IEEE 754.
    // The helper round2's after summing, not per line.
    const lines = Array.from({ length: 100 }, () => ({ retail: 0.1, cost: 0.05 }));
    const r = aggregateMargin(lines);
    expect(r.retail).toBe(10);
    expect(r.cost).toBe(5);
    expect(r.margin).toBe(5);
  });
});

describe("applyShare", () => {
  it("returns the line unchanged at a whole share (not a split)", () => {
    const line = { retail: 1000, cost: 400 };
    const result = applyShare(line, 1);
    expect(result).toEqual(line);
  });

  it("halves retail AND cost on an even split, preserving margin%", () => {
    const line = { retail: 1000, cost: 400 };
    const half = applyShare(line, 0.5);
    expect(half.retail).toBe(500);
    expect(half.cost).toBe(200);
    // Critical invariant: each salesperson sees the same margin% as the
    // un-split line. 600/1000 = 0.6 = 300/500.
    const fullMargin = aggregateMargin([line]).marginPct;
    const halfMargin = aggregateMargin([half]).marginPct;
    expect(halfMargin).toBeCloseTo(fullMargin, 4);
  });

  it("two halves of a split sum to the full line", () => {
    // Both salespeople run the report; their numbers add up to the
    // original sale. This is what HR will spot-check against.
    const line = { retail: 1000, cost: 400 };
    const half = applyShare(line, 0.5);
    const sum = aggregateMargin([half, half]);
    const full = aggregateMargin([line]);
    expect(sum.retail).toBeCloseTo(full.retail, 2);
    expect(sum.cost).toBeCloseTo(full.cost, 2);
    expect(sum.margin).toBeCloseTo(full.margin, 2);
  });

  it("an uneven split's two shares sum to the full line, each at the line's margin%", () => {
    // GAP-07: a 60/40 split. The salesperson sees 60% of the retail and the
    // cost, the partner 40%; the two add up to the sale.
    const line = { retail: 1000, cost: 400 };
    const primary = applyShare(line, 0.6);
    const partner = applyShare(line, 0.4);
    expect([primary.retail, partner.retail]).toEqual([600, 400]);
    expect(aggregateMargin([primary]).marginPct).toBeCloseTo(0.6, 4);
    expect(aggregateMargin([primary, partner]).retail).toBeCloseTo(1000, 2);
  });
});

describe("formatMarginPct", () => {
  it("formats positive margin% with one decimal", () => {
    expect(formatMarginPct(0.354)).toBe("35.4%");
    expect(formatMarginPct(0.6)).toBe("60.0%");
  });

  it("formats zero as 0.0%", () => {
    expect(formatMarginPct(0)).toBe("0.0%");
  });

  it("formats negative margin% with minus sign", () => {
    expect(formatMarginPct(-0.15)).toBe("-15.0%");
  });

  it("returns dash for non-finite values (defensive — should not happen with aggregateMargin)", () => {
    expect(formatMarginPct(Number.NaN)).toBe("—");
    expect(formatMarginPct(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatMarginPct(Number.NEGATIVE_INFINITY)).toBe("—");
  });

  it("rounds half-up at the displayed precision", () => {
    // 0.355 -> 35.5% (the .5 rounds up to .5 when toFixed(1) is called)
    expect(formatMarginPct(0.355)).toBe("35.5%");
  });
});

describe("imputeMissingCost", () => {
  it("imputes cost = retail/2 when cost is zero and retail is positive", () => {
    // Zero-cost line is the bug shape we're fixing: many auto-created
    // products land with cost = 0 from the POS imports, making them
    // look like 100%-margin lines. Treat as 50% margin instead.
    const line = { retail: 1000, cost: 0 };
    const imputed = imputeMissingCost(line);
    expect(imputed.retail).toBe(1000);
    expect(imputed.cost).toBe(500);

    const r = aggregateMargin([imputed]);
    expect(r.marginPct).toBe(0.5);
  });

  it("imputes cost = retail/2 on a return line (negative retail)", () => {
    // Returns flip the signs but the imputation still produces 50%.
    const line = { retail: -1000, cost: 0 };
    const imputed = imputeMissingCost(line);
    expect(imputed.cost).toBe(-500);

    const r = aggregateMargin([imputed]);
    expect(r.marginPct).toBeCloseTo(0.5, 4);
  });

  it("leaves a line with non-zero cost untouched", () => {
    // Real cost data wins over imputation. A line that says cost = $1
    // is a 99.9% margin line; we don't second-guess it.
    const line = { retail: 1000, cost: 1 };
    const imputed = imputeMissingCost(line);
    expect(imputed).toBe(line); // same reference -- no allocation
    expect(imputed.cost).toBe(1);
  });

  it("leaves a fully-zero line untouched (nothing to impute from)", () => {
    // Both sides zero -- nothing to do, no division-by-zero hazard.
    const line = { retail: 0, cost: 0 };
    const imputed = imputeMissingCost(line);
    expect(imputed).toBe(line);
  });

  it("composes correctly with applyShare (order independent)", () => {
    // Whether you impute-then-split or split-then-impute, you should
    // arrive at the same margin% (50%). This is a property the
    // pipeline relies on -- the aggregator doesn't know which order
    // the data layer applied them in.
    const line = { retail: 1000, cost: 0 };

    const imputeFirst = applyShare(imputeMissingCost(line), 0.5);
    expect(imputeFirst).toEqual({ retail: 500, cost: 250 });

    const splitFirst = imputeMissingCost(applyShare(line, 0.5));
    expect(splitFirst).toEqual({ retail: 500, cost: 250 });

    expect(aggregateMargin([imputeFirst]).marginPct).toBeCloseTo(0.5, 4);
    expect(aggregateMargin([splitFirst]).marginPct).toBeCloseTo(0.5, 4);
  });

  it("does not mutate the input line", () => {
    const line = { retail: 1000, cost: 0 };
    const imputed = imputeMissingCost(line);
    expect(line.cost).toBe(0); // original unchanged
    expect(imputed.cost).toBe(500);
  });
});
