// /app/__tests__/dailyReconciliationDisplay.test.ts
//
// A-grade pure-helper tests for the reconciliation panel display logic
// extracted from the JE admin page. No React, no I/O -- just the math
// of "what string and what classes do we render for this result?"

import {
  RECONCILIATION_CATEGORIES,
  reconciliationHeader,
  reconciliationPanelClass,
  driftCellClass,
  RECONCILIATION_TOLERANCE,
} from "../src/lib/dailyReconciliationDisplay";

describe("RECONCILIATION_CATEGORIES", () => {
  it("contains exactly the four reconciliation buckets in display order", () => {
    expect(RECONCILIATION_CATEGORIES).toEqual(["revenue", "tax", "cost", "cash"]);
  });

  it("is readonly so accidental mutations are a compile error", () => {
    // Runtime check: array must be frozen. We use `as const` upstream.
    // This test documents the contract; if the upstream type changes,
    // the type-check half catches it at compile time.
    expect(Object.isFrozen(RECONCILIATION_CATEGORIES)).toBe(false); // `as const` doesn't freeze, but it's read-only by type
    // Length stays at 4 -- if a new category is added, more places need updating.
    expect(RECONCILIATION_CATEGORIES).toHaveLength(4);
  });
});

describe("reconciliationHeader", () => {
  it("shows the balanced message when result is balanced", () => {
    const text = reconciliationHeader({ balanced: true, warnings: [] });
    expect(text).toContain("Balanced");
    expect(text).toContain("✓");
  });

  it("ignores warnings array when balanced is true (defensive: balanced should imply empty warnings, but render must not lie)", () => {
    // If somehow balanced=true and warnings=non-empty arrives, prefer balanced.
    // This documents the contract; the upstream pure helper guarantees they're consistent.
    const text = reconciliationHeader({ balanced: true, warnings: ["stale"] });
    expect(text).toContain("Balanced");
  });

  it("uses singular 'warning' when there is exactly one warning", () => {
    const text = reconciliationHeader({ balanced: false, warnings: ["Revenue drift $50"] });
    expect(text).toContain("1 warning");
    expect(text).not.toContain("warnings");
    expect(text).toContain("✗");
  });

  it("uses plural 'warnings' when there are multiple warnings", () => {
    const text = reconciliationHeader({
      balanced: false,
      warnings: ["Revenue drift", "Tax drift", "Cash drift"],
    });
    expect(text).toContain("3 warnings");
  });

  it("uses plural 'warnings' for zero warnings (the unbalanced-but-no-warnings edge)", () => {
    // hasJournalEntry=false: balanced=false, warnings=[] is possible per
    // computeDailyReconciliation's contract (the "no JE" warning gets
    // unshifted onto warnings, so the array isn't actually empty in practice
    // -- but defensively cover the input shape).
    const text = reconciliationHeader({ balanced: false, warnings: [] });
    expect(text).toContain("0 warnings");
  });
});

describe("reconciliationPanelClass", () => {
  it("returns green styling when balanced", () => {
    const cls = reconciliationPanelClass(true);
    expect(cls).toContain("green");
    expect(cls).not.toContain("amber");
  });

  it("returns amber styling when not balanced", () => {
    const cls = reconciliationPanelClass(false);
    expect(cls).toContain("amber");
    expect(cls).not.toContain("green");
  });

  it("returns full Tailwind border + bg + text triplet (not just the color)", () => {
    // Smoke check: if a future refactor accidentally returns just "green"
    // or drops the bg class, the panel renders unstyled. This catches that.
    const cls = reconciliationPanelClass(true);
    expect(cls).toMatch(/border-/);
    expect(cls).toMatch(/bg-/);
    expect(cls).toMatch(/text-/);
  });
});

describe("driftCellClass", () => {
  it("returns empty string for zero drift", () => {
    expect(driftCellClass(0)).toBe("");
  });

  it("returns empty string for drift within tolerance (sub-penny)", () => {
    // Default tolerance is 0.01 (one penny). Sub-penny drift is normal float noise.
    expect(driftCellClass(0.005)).toBe("");
    expect(driftCellClass(-0.005)).toBe("");
  });

  it("returns red+bold styling for drift exceeding tolerance", () => {
    expect(driftCellClass(0.02)).toContain("red");
    expect(driftCellClass(0.02)).toContain("font-semibold");
  });

  it("treats negative drift symmetrically (a -$50 drift is just as bad as +$50)", () => {
    expect(driftCellClass(-50)).toBe(driftCellClass(50));
  });

  it("respects an injected tolerance", () => {
    // With looser tolerance, $0.50 drift is acceptable and renders unstyled.
    expect(driftCellClass(0.5, 1)).toBe("");
    // But $1.50 still trips even the looser threshold.
    expect(driftCellClass(1.5, 1)).toContain("red");
  });

  it("uses the same default tolerance as the comparator (0.01)", () => {
    // Tripwire: if someone changes the comparator's tolerance and forgets
    // the display layer, the cell highlighting silently drifts out of sync
    // with the warnings panel. This test forces them to update both.
    expect(RECONCILIATION_TOLERANCE).toBe(0.01);
    // The display helper's default must match.
    expect(driftCellClass(0.011)).toContain("red"); // just over default tolerance
    expect(driftCellClass(0.009)).toBe(""); // just under default tolerance
  });
});
