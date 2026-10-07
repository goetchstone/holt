// /app/__tests__/dailyReconciliation.test.ts
//
// Pure-helper tests for compareReconciliation. A-grade — exercises
// the comparator math directly.
//
// The DB-touching wrapper computeDailyReconciliation() is now covered
// by __tests__/integration/dailyReconciliation.integration.test.ts
// (Phase 0.6.3, 2026-05-01). The mocked-Prisma orchestration tests
// previously in this file were deleted as part of that conversion.
//
// Phase 0 control C1 from the SOR plan (2026-04-28).

import { compareReconciliation, RECONCILIATION_TOLERANCE } from "../src/lib/dailyReconciliation";
import { OVER_SHORT_ALERT_THRESHOLD } from "../src/lib/glMapping";

describe("compareReconciliation", () => {
  const balancedSource = {
    revenue: 1000,
    tax: 63.5,
    cost: 400,
    cash: 1063.5,
  };
  const balancedJournal = {
    revenue: 1000,
    tax: 63.5,
    cost: 400,
    cash: 1063.5,
    overShort: 0,
  };

  it("reports balanced when all four pairs match", () => {
    const result = compareReconciliation(balancedSource, balancedJournal);
    expect(result.balanced).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.drift).toEqual({ revenue: 0, tax: 0, cost: 0, cash: 0 });
  });

  it("flags revenue drift specifically", () => {
    const result = compareReconciliation(balancedSource, {
      ...balancedJournal,
      revenue: 950, // $50 less than source -- maybe JE missed line items
    });
    expect(result.balanced).toBe(false);
    expect(result.drift.revenue).toBe(50);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Revenue drift");
    expect(result.warnings[0]).toContain("50.00");
  });

  it("flags multiple drifts in one run", () => {
    const result = compareReconciliation(balancedSource, {
      revenue: 950,
      tax: 60,
      cost: 410,
      cash: 1050,
      overShort: 0,
    });
    expect(result.balanced).toBe(false);
    expect(result.warnings).toHaveLength(4);
    expect(result.drift).toEqual({
      revenue: 50,
      tax: 3.5,
      cost: -10,
      cash: 13.5,
    });
  });

  it("ignores drift within tolerance (floating-point safety)", () => {
    // Source has $1000.00, journal has $1000.005 -- within $0.01 tolerance
    const result = compareReconciliation(balancedSource, {
      ...balancedJournal,
      revenue: 1000.005,
    });
    expect(result.balanced).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("flags drift exactly at the tolerance boundary as imbalanced", () => {
    // Drift is $0.02, just over the $0.01 tolerance
    const result = compareReconciliation(balancedSource, {
      ...balancedJournal,
      revenue: 999.98,
    });
    expect(result.balanced).toBe(false);
    expect(result.drift.revenue).toBe(0.02);
  });

  it("handles return-day shape (negative source amounts)", () => {
    // Day has only refunds: source revenue is negative, JE shape mirrors
    const result = compareReconciliation(
      { revenue: -500, tax: -31.75, cost: -200, cash: -531.75 },
      { revenue: -500, tax: -31.75, cost: -200, cash: -531.75, overShort: 0 },
    );
    expect(result.balanced).toBe(true);
  });

  it("uses an injectable tolerance for looser checks", () => {
    // A $5 drift would normally be flagged with the default $0.01 tolerance.
    // Looser $10 tolerance accepts it. (Tighter-than-penny tolerance is
    // meaningless because round2() in the comparator rounds to 2 decimals
    // before testing -- the underlying data is dollars-and-cents.)
    const looser = compareReconciliation(balancedSource, { ...balancedJournal, revenue: 1005 }, 10);
    expect(looser.balanced).toBe(true);

    const default_tolerance = compareReconciliation(balancedSource, {
      ...balancedJournal,
      revenue: 1005,
    });
    expect(default_tolerance.balanced).toBe(false);
  });

  it("exposes RECONCILIATION_TOLERANCE as a stable constant", () => {
    // Tripwire so a future "loosen the tolerance" PR is visible
    expect(RECONCILIATION_TOLERANCE).toBe(0.01);
  });

  // ─── Over/Short plug ──────────────────────────────────────────
  //
  // The plug has no source-side counterpart, so it is not a drift
  // category. It is reported on its own and it is never revenue.

  it("flags a material Over/Short plug even when every drift pair matches", () => {
    // The dangerous shape: source and journal agree on all four buckets
    // because the plug is what made them agree. Before the plug was pulled
    // out of the revenue bucket, this day reported clean.
    const result = compareReconciliation(balancedSource, {
      ...balancedJournal,
      overShort: 12000,
    });
    expect(result.balanced).toBe(false);
    expect(result.drift).toEqual({ revenue: 0, tax: 0, cost: 0, cash: 0 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Over/Short plug $12000.00");
    expect(result.warnings[0]).toContain("balances only because of it");
  });

  it("does not flag a rounding-sized plug", () => {
    // $0.02 of rounding is noise. It is still reported as journal.overShort
    // (the log column and both admin tables show it), it just does not turn
    // the day amber.
    const result = compareReconciliation(balancedSource, {
      ...balancedJournal,
      overShort: 0.02,
    });
    expect(result.balanced).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("flags a plug in either direction", () => {
    const credit = compareReconciliation(balancedSource, { ...balancedJournal, overShort: 5000 });
    const debit = compareReconciliation(balancedSource, { ...balancedJournal, overShort: -5000 });
    expect(credit.balanced).toBe(false);
    expect(debit.balanced).toBe(false);
    expect(debit.warnings[0]).toContain("5000.00");
  });

  it("grades the plug at OVER_SHORT_ALERT_THRESHOLD, not the drift tolerance", () => {
    // Boundary tripwire. A $0.50 plug sits above the $0.01 drift tolerance
    // but below the $1.00 plug threshold -- it must NOT flag, or every
    // rounding day goes amber.
    const under = compareReconciliation(balancedSource, { ...balancedJournal, overShort: 0.5 });
    expect(under.balanced).toBe(true);

    const over = compareReconciliation(balancedSource, {
      ...balancedJournal,
      overShort: OVER_SHORT_ALERT_THRESHOLD + 0.01,
    });
    expect(over.balanced).toBe(false);
  });

  it("exposes OVER_SHORT_ALERT_THRESHOLD as a stable constant", () => {
    // Same tripwire intent as the tolerance one above: raising the bar for
    // "this plug is worth waking someone about" should be visible in a diff.
    expect(OVER_SHORT_ALERT_THRESHOLD).toBe(1.0);
  });
});
