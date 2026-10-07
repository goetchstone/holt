// /app/__tests__/buyerDraftValidation.test.ts
//
// A-grade tests for the buyer-draft drop-compatibility helper.

import { isCompatiblePoForItem } from "@/lib/buyerDraftValidation";

describe("isCompatiblePoForItem", () => {
  it("allows same-vendor drops", () => {
    const r = isCompatiblePoForItem({ vendorId: 2 }, { vendorId: 2 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("");
  });

  it("blocks cross-vendor drops (the actual user-reported bug)", () => {
    // AL item (vendor 2) into Bradington Young PO (vendor 12) — must be rejected.
    const r = isCompatiblePoForItem({ vendorId: 2 }, { vendorId: 12 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Cross-vendor drop blocked");
    expect(r.reason).toContain("2");
    expect(r.reason).toContain("12");
  });

  it("allows when both sides have null vendorId (degenerate but harmless)", () => {
    const r = isCompatiblePoForItem({ vendorId: null }, { vendorId: null });
    expect(r.ok).toBe(true);
  });

  it("allows when item has null vendor and PO has a vendor (lenient — mid-edit)", () => {
    const r = isCompatiblePoForItem({ vendorId: null }, { vendorId: 5 });
    expect(r.ok).toBe(true);
  });

  it("allows when PO has null vendor and item has a vendor (lenient — mid-edit)", () => {
    const r = isCompatiblePoForItem({ vendorId: 5 }, { vendorId: null });
    expect(r.ok).toBe(true);
  });

  it("uses the item and PO vendor ids verbatim in the reason for operator drill-down", () => {
    const r = isCompatiblePoForItem({ vendorId: 42 }, { vendorId: 99 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/item vendor \(42\)/);
    expect(r.reason).toMatch(/PO vendor \(99\)/);
  });
});
