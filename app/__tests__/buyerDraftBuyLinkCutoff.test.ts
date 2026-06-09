// /app/__tests__/buyerDraftBuyLinkCutoff.test.ts
//
// A-grade tests for `computeBuyLinkCutoff` — pure helper, no I/O.
//
// Origin (2026-05-15): user-reported buyer-drafts performance page
// showing 2023 sales + all-time receiving qty on Spring 2026 buy.
// Reproduced against the 2026-05-15 backup — 71 linked POs spanned
// 2023-04 → 2026-04 via productId-only match. The cutoff helper
// computes a sensible lower bound that drops the 2023 noise without
// erasing legitimate Spring-buy POs placed in 2025.

import { computeBuyLinkCutoff, type DraftPoForCutoff } from "@/lib/buyerDraftBuyLinkCutoff";

function po(expectedShipMonth: string | null): DraftPoForCutoff {
  return {
    expectedShipMonth:
      expectedShipMonth === null ? null : new Date(`${expectedShipMonth}-01T00:00:00Z`),
  };
}

describe("computeBuyLinkCutoff", () => {
  it("returns the earliest expectedShipMonth minus 12 months", () => {
    // Spring 2026 buy has draft POs with expectedShipMonth 2026-01 through 2026-04
    const drafts = [po("2026-03"), po("2026-01"), po("2026-02"), po("2026-04")];
    const buyCreated = new Date("2026-05-09T00:00:00Z");
    const cutoff = computeBuyLinkCutoff(drafts, buyCreated);
    // Earliest ship = 2026-01-01; minus 12 months = 2025-01-01
    expect(cutoff?.toISOString().slice(0, 10)).toBe("2025-01-01");
  });

  it("falls back to buy.created when no draft PO has expectedShipMonth", () => {
    const drafts = [po(null), po(null), po(null)];
    const buyCreated = new Date("2026-05-09T00:00:00Z");
    const cutoff = computeBuyLinkCutoff(drafts, buyCreated);
    // Anchor = buyCreated 2026-05-09; minus 12 months = 2025-05-09
    expect(cutoff?.toISOString().slice(0, 10)).toBe("2025-05-09");
  });

  it("ignores null expectedShipMonth entries when computing the min", () => {
    // Mixed: some null, some set. Only the non-null ones inform the min.
    const drafts = [po(null), po("2026-02"), po(null), po("2026-04")];
    const buyCreated = new Date("2026-05-09T00:00:00Z");
    const cutoff = computeBuyLinkCutoff(drafts, buyCreated);
    expect(cutoff?.toISOString().slice(0, 10)).toBe("2025-02-01");
  });

  it("returns a cutoff (not null) for an empty draft-PO list using buy.created fallback", () => {
    // No draft POs at all — still produce a sensible cutoff from buy.created.
    const cutoff = computeBuyLinkCutoff([], new Date("2026-05-09T00:00:00Z"));
    expect(cutoff?.toISOString().slice(0, 10)).toBe("2025-05-09");
  });

  it("respects custom monthsBefore parameter", () => {
    const drafts = [po("2026-04")];
    const buyCreated = new Date("2026-05-09T00:00:00Z");
    // Tighter (6mo) — pulls fewer historical POs in, useful for mid-season replenishment
    const tight = computeBuyLinkCutoff(drafts, buyCreated, 6);
    expect(tight?.toISOString().slice(0, 10)).toBe("2025-10-01");
    // Wider (24mo) — covers long-lead-time custom pieces
    const wide = computeBuyLinkCutoff(drafts, buyCreated, 24);
    expect(wide?.toISOString().slice(0, 10)).toBe("2024-04-01");
  });

  it("handles December → January month-rollback correctly", () => {
    // Earliest ship 2026-02; minus 12 months crosses into 2025-02 (clean year boundary)
    const drafts = [po("2026-02")];
    const buyCreated = new Date("2026-01-15T00:00:00Z");
    const cutoff = computeBuyLinkCutoff(drafts, buyCreated);
    expect(cutoff?.toISOString().slice(0, 10)).toBe("2025-02-01");
  });

  it("handles January → previous-year December correctly (months can be negative-rolled)", () => {
    // Earliest ship 2026-01; minus 12 months = 2025-01.
    // Then test the boundary: earliest 2026-01, minus 13 months = 2024-12.
    const drafts = [po("2026-01")];
    const buyCreated = new Date("2026-05-09T00:00:00Z");
    const cutoff = computeBuyLinkCutoff(drafts, buyCreated, 13);
    expect(cutoff?.toISOString().slice(0, 10)).toBe("2024-12-01");
  });

  it("returns ≥1-year-ago for a typical Spring 2026 backfill scenario", () => {
    // Spring 2026 buy created 2026-05-09 (after most POs were already
    // placed). Draft POs span 2026-01 → 2026-04. Cutoff should be
    // 2025-01 — early enough to capture POs placed at Oct 2025 market,
    // late enough to exclude 2023 historical noise.
    const drafts = [po("2026-01"), po("2026-02"), po("2026-03"), po("2026-04")];
    const buyCreated = new Date("2026-05-09T00:00:00Z");
    const cutoff = computeBuyLinkCutoff(drafts, buyCreated);
    expect(cutoff).not.toBeNull();
    const cutoffDate = cutoff as Date;
    // Cutoff is BEFORE Jan 2025 market (good — captures fall market POs)
    expect(cutoffDate.getUTCFullYear()).toBeLessThanOrEqual(2025);
    // Cutoff is AFTER Jan 2024 (good — excludes 2023 noise)
    expect(cutoffDate.getTime()).toBeGreaterThan(new Date("2024-01-01T00:00:00Z").getTime());
  });

  it("a draft PO with very early expectedShipMonth wins (sets the cutoff)", () => {
    // Edge case: one draft PO has a much earlier expectedShipMonth than
    // the rest. Cutoff anchors on that earliest one — caller should
    // notice and fix the outlier rather than ship with wrong window.
    const drafts = [po("2025-06"), po("2026-02"), po("2026-04")];
    const buyCreated = new Date("2026-05-09T00:00:00Z");
    const cutoff = computeBuyLinkCutoff(drafts, buyCreated);
    // Earliest ship = 2025-06; minus 12 months = 2024-06
    expect(cutoff?.toISOString().slice(0, 10)).toBe("2024-06-01");
  });
});
