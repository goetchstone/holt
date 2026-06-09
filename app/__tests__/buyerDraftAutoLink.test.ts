// /app/__tests__/buyerDraftAutoLink.test.ts
//
// A-grade tests for the pure auto-link planner. No DB, no I/O.

import { planAutoLinks, type DraftCandidate, type UpcIndex } from "@/lib/buyerDraftAutoLink";

const draft = (
  id: number,
  barcode: string,
  status = "EXPORTED",
  fulfilledProductId: number | null = null,
): DraftCandidate => ({ id, barcode, status, fulfilledProductId });

describe("planAutoLinks", () => {
  it("links a single EXPORTED draft whose barcode matches a Product UPC", () => {
    const drafts = [draft(1, "012345678905")];
    const upcs: UpcIndex = new Map([["012345678905", 9001]]);
    expect(planAutoLinks(drafts, upcs)).toEqual({
      links: [{ draftId: 1, productId: 9001 }],
      unmatchedDraftIds: [],
    });
  });

  it("skips drafts that already have fulfilledProductId set (idempotent)", () => {
    const drafts = [
      draft(1, "012345678905", "EXPORTED", 9001), // already linked
      draft(2, "987654321098"), // fresh
    ];
    const upcs: UpcIndex = new Map([
      ["012345678905", 9001],
      ["987654321098", 9002],
    ]);
    expect(planAutoLinks(drafts, upcs)).toEqual({
      links: [{ draftId: 2, productId: 9002 }],
      unmatchedDraftIds: [],
    });
  });

  it("skips drafts in non-EXPORTED status (DRAFT, READY, FULFILLED, CANCELLED)", () => {
    const drafts = [
      draft(1, "012345678905", "DRAFT"),
      draft(2, "012345678906", "READY"),
      draft(3, "012345678907", "FULFILLED"),
      draft(4, "012345678908", "CANCELLED"),
      draft(5, "012345678909", "EXPORTED"), // the only one eligible
    ];
    const upcs: UpcIndex = new Map([
      ["012345678905", 1],
      ["012345678906", 2],
      ["012345678907", 3],
      ["012345678908", 4],
      ["012345678909", 5],
    ]);
    expect(planAutoLinks(drafts, upcs)).toEqual({
      links: [{ draftId: 5, productId: 5 }],
      unmatchedDraftIds: [],
    });
  });

  it("reports unmatched draft IDs when no UPC match found", () => {
    const drafts = [draft(1, "012345678905"), draft(2, "no-product-yet")];
    const upcs: UpcIndex = new Map([["012345678905", 9001]]);
    expect(planAutoLinks(drafts, upcs)).toEqual({
      links: [{ draftId: 1, productId: 9001 }],
      unmatchedDraftIds: [2],
    });
  });

  it("skips drafts with empty or whitespace-only barcode", () => {
    const drafts = [draft(1, ""), draft(2, "   "), draft(3, "012345678905")];
    const upcs: UpcIndex = new Map([["012345678905", 9001]]);
    expect(planAutoLinks(drafts, upcs)).toEqual({
      links: [{ draftId: 3, productId: 9001 }],
      unmatchedDraftIds: [],
    });
  });

  it("is case-sensitive on barcode match (matches CLAUDE.md note: alphanumeric ID)", () => {
    // Mixed-case barcodes are different identifiers. We don't lowercase
    // because Marjan rug barcodes (e.g. "M1812-91") would alias with
    // "m1812-91" — wrong product.
    const drafts = [draft(1, "M1812-91")];
    const upcs: UpcIndex = new Map([["m1812-91", 9001]]); // lowercase
    expect(planAutoLinks(drafts, upcs)).toEqual({
      links: [],
      unmatchedDraftIds: [1],
    });
  });

  it("returns empty for empty inputs", () => {
    expect(planAutoLinks([], new Map())).toEqual({
      links: [],
      unmatchedDraftIds: [],
    });
  });

  it("preserves draft order in the output (deterministic)", () => {
    const drafts = [draft(7, "u-7"), draft(3, "u-3"), draft(5, "u-5")];
    const upcs: UpcIndex = new Map([
      ["u-7", 700],
      ["u-3", 300],
      ["u-5", 500],
    ]);
    const plan = planAutoLinks(drafts, upcs);
    expect(plan.links.map((l) => l.draftId)).toEqual([7, 3, 5]);
  });

  it("handles multiple drafts mapping to the same product (does not deduplicate)", () => {
    // Edge case — two draft items both happen to have the same UPC.
    // Probably a buyer-input error (two drafts for the same product),
    // but the planner doesn't second-guess — both get linked to the
    // same product and the buyer can fix duplicates manually.
    const drafts = [draft(1, "shared-upc"), draft(2, "shared-upc")];
    const upcs: UpcIndex = new Map([["shared-upc", 9001]]);
    expect(planAutoLinks(drafts, upcs)).toEqual({
      links: [
        { draftId: 1, productId: 9001 },
        { draftId: 2, productId: 9001 },
      ],
      unmatchedDraftIds: [],
    });
  });
});
