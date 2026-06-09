// /app/__tests__/buyerDraftPoAutoLink.test.ts
//
// Slice 6.14 (2026-05-22) — A-grade tests for the planPoAutoLinks
// helper. No I/O.

import {
  planPoAutoLinks,
  DEFAULT_MATCH_THRESHOLD,
  type RealPoForAutoLink,
  type DraftPoForAutoLink,
} from "@/lib/buyerDraftPoAutoLink";

function realPo(overrides: Partial<RealPoForAutoLink> = {}): RealPoForAutoLink {
  return {
    id: 100,
    vendorId: 42,
    partNos: ["WH-A", "WH-B", "WH-C"],
    productIds: [1, 2, 3],
    alreadyLinked: false,
    ...overrides,
  };
}

function draftPo(overrides: Partial<DraftPoForAutoLink> = {}): DraftPoForAutoLink {
  return {
    id: 200,
    vendorId: 42,
    status: "EXPORTED",
    partNumbers: ["WH-A", "WH-B", "WH-C"],
    fulfilledProductIds: [1, 2, 3],
    ...overrides,
  };
}

describe("planPoAutoLinks", () => {
  it("returns empty plan when no real POs", () => {
    const r = planPoAutoLinks([], [draftPo()]);
    expect(r.links).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("returns empty plan when no draft POs", () => {
    const r = planPoAutoLinks([realPo()], []);
    expect(r.links).toEqual([]);
    expect(r.skipped[0].reason).toBe("no-vendor-match");
  });

  it("skips real POs already linked", () => {
    const r = planPoAutoLinks([realPo({ alreadyLinked: true })], [draftPo()]);
    expect(r.links).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("already-linked");
  });

  it("links a perfect match (same vendor, identical partNos)", () => {
    const r = planPoAutoLinks([realPo()], [draftPo()]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toEqual({ draftPoId: 200, realPoId: 100, matchScore: 1 });
    expect(r.skipped).toEqual([]);
  });

  it("links when overlap is at threshold (60%)", () => {
    // Real has 5 signals (3 partNos + 2 productIds with overlap on first 3),
    // actually let me reshape: 5 distinct signals on the real PO, 3 of them
    // present on the draft = 60% overlap.
    const real = realPo({ partNos: ["A", "B", "C", "D", "E"], productIds: [] });
    const draft = draftPo({ partNumbers: ["A", "B", "C"], fulfilledProductIds: [] });
    const r = planPoAutoLinks([real], [draft]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0].matchScore).toBeCloseTo(0.6);
  });

  it("skips when overlap is just below threshold", () => {
    const real = realPo({ partNos: ["A", "B", "C", "D", "E"], productIds: [] });
    const draft = draftPo({ partNumbers: ["A", "B"], fulfilledProductIds: [] });
    const r = planPoAutoLinks([real], [draft]);
    expect(r.links).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("below-threshold");
    expect(r.skipped[0].candidateDraftPoIds).toEqual([200]);
  });

  it("skips draft POs in FULFILLED or CANCELLED status", () => {
    const fulfilled = draftPo({ id: 201, status: "FULFILLED" });
    const cancelled = draftPo({ id: 202, status: "CANCELLED" });
    const r = planPoAutoLinks([realPo()], [fulfilled, cancelled]);
    expect(r.links).toEqual([]);
    expect(r.skipped[0].reason).toBe("no-vendor-match");
  });

  it("considers DRAFT / READY / EXPORTED draft POs as candidates", () => {
    const realA = realPo({ id: 100, partNos: ["A"], productIds: [] });
    const realB = realPo({ id: 101, partNos: ["B"], productIds: [] });
    const realC = realPo({ id: 102, partNos: ["C"], productIds: [] });
    const draftA = draftPo({
      id: 200,
      status: "DRAFT",
      partNumbers: ["A"],
      fulfilledProductIds: [],
    });
    const draftB = draftPo({
      id: 201,
      status: "READY",
      partNumbers: ["B"],
      fulfilledProductIds: [],
    });
    const draftC = draftPo({
      id: 202,
      status: "EXPORTED",
      partNumbers: ["C"],
      fulfilledProductIds: [],
    });
    const r = planPoAutoLinks([realA, realB, realC], [draftA, draftB, draftC]);
    expect(r.links.map((l) => l.draftPoId).sort()).toEqual([200, 201, 202]);
  });

  it("flags ambiguous when multiple candidates clear the threshold", () => {
    // Two draft POs from the same vendor, both with the same partNo set.
    const dup1 = draftPo({ id: 200 });
    const dup2 = draftPo({ id: 201 });
    const r = planPoAutoLinks([realPo()], [dup1, dup2]);
    expect(r.links).toEqual([]);
    expect(r.skipped[0].reason).toBe("ambiguous-multiple-candidates");
    expect(r.skipped[0].candidateDraftPoIds?.sort()).toEqual([200, 201]);
  });

  it("matches via fulfilledProductId when partNos differ", () => {
    // The buyer typed a different partNumber from what the POS ended up
    // using on the real PO, but Slice 5 already linked the draft item to
    // the real Product via barcode — so fulfilledProductId catches it.
    const real = realPo({ partNos: ["DIFFERENT-PN"], productIds: [1, 2, 3] });
    const draft = draftPo({ partNumbers: ["TYPED-PN"], fulfilledProductIds: [1, 2, 3] });
    const r = planPoAutoLinks([real], [draft]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0].draftPoId).toBe(200);
  });

  it("counts signals as a union of partNos + productIds (de-duped)", () => {
    // 3 partNos + 3 productIds with overlap on 2 (i.e. the productId is
    // the same as one of the partNos' product). The set semantics should
    // de-dupe so the threshold math doesn't get inflated.
    const real = realPo({
      partNos: ["pn:1", "pn:2", "pn:3"],
      productIds: [1, 2, 3],
    });
    // Draft has all 6 distinct signals
    const draft = draftPo({
      partNumbers: ["pn:1", "pn:2", "pn:3"],
      fulfilledProductIds: [1, 2, 3],
    });
    const r = planPoAutoLinks([real], [draft]);
    expect(r.links[0].matchScore).toBe(1);
  });

  it("rejects vendor mismatch even when items overlap perfectly", () => {
    const real = realPo({ vendorId: 42 });
    const draftWrongVendor = draftPo({ vendorId: 99 });
    const r = planPoAutoLinks([real], [draftWrongVendor]);
    expect(r.links).toEqual([]);
    expect(r.skipped[0].reason).toBe("no-vendor-match");
  });

  it("skips real POs with no partNos AND no productIds (no signal)", () => {
    const real = realPo({ partNos: [], productIds: [] });
    const r = planPoAutoLinks([real], [draftPo()]);
    expect(r.links).toEqual([]);
    expect(r.skipped[0].reason).toBe("no-signal-overlap");
  });

  it("doesn't attach the same draft PO to two real POs in one pass", () => {
    // If two real POs both perfectly match the same draft, only the
    // first one (in input order) gets the link. The second falls to
    // below-threshold because the draft is no longer in the candidate
    // pool. Prevents accidental double-attach.
    const realA = realPo({ id: 100 });
    const realB = realPo({ id: 101 });
    const draft = draftPo({ id: 200 });
    const r = planPoAutoLinks([realA, realB], [draft]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0].realPoId).toBe(100);
    expect(r.skipped[0].realPoId).toBe(101);
    expect(r.skipped[0].reason).toBe("below-threshold");
  });

  it("handles custom threshold (lower)", () => {
    const real = realPo({ partNos: ["A", "B", "C", "D", "E"], productIds: [] });
    const draft = draftPo({ partNumbers: ["A"], fulfilledProductIds: [] }); // 20% overlap
    const r = planPoAutoLinks([real], [draft], { threshold: 0.2 });
    expect(r.links).toHaveLength(1);
    expect(r.links[0].matchScore).toBeCloseTo(0.2);
  });

  it("handles custom threshold (higher, stricter)", () => {
    const r = planPoAutoLinks([realPo()], [draftPo()], { threshold: 1 });
    // Perfect match still passes threshold=1
    expect(r.links).toHaveLength(1);
    const r2 = planPoAutoLinks(
      [realPo({ partNos: ["A", "B", "C"] })],
      [draftPo({ partNumbers: ["A", "B"] })],
      { threshold: 1 },
    );
    // Two-of-three overlap → score < 1 → fails threshold=1
    expect(r2.links).toHaveLength(0);
  });

  it("exposes DEFAULT_MATCH_THRESHOLD constant", () => {
    expect(DEFAULT_MATCH_THRESHOLD).toBe(0.6);
  });

  it("handles a realistic Spring 2026-shape batch (3 PONs, 3 draft POs, one ambiguous vendor)", () => {
    const realPos: RealPoForAutoLink[] = [
      {
        id: 1,
        vendorId: 10,
        partNos: ["WH-Sofa", "WH-Chair"],
        productIds: [100, 101],
        alreadyLinked: false,
      },
      {
        id: 2,
        vendorId: 20,
        partNos: ["CRL-Table"],
        productIds: [200],
        alreadyLinked: false,
      },
      {
        id: 3,
        vendorId: 30,
        partNos: ["BY-Lounger"],
        productIds: [300],
        alreadyLinked: false,
      },
    ];
    const draftPos: DraftPoForAutoLink[] = [
      {
        id: 1,
        vendorId: 10,
        status: "EXPORTED",
        partNumbers: ["WH-Sofa", "WH-Chair"],
        fulfilledProductIds: [100, 101],
      },
      {
        id: 2,
        vendorId: 20,
        status: "EXPORTED",
        partNumbers: ["CRL-Table"],
        fulfilledProductIds: [200],
      },
      // No draft PO for BY — that real PO should skip with no-signal candidates
    ];
    const r = planPoAutoLinks(realPos, draftPos);
    expect(r.links).toHaveLength(2);
    expect(r.links.map((l) => `${l.realPoId}->${l.draftPoId}`).sort()).toEqual(["1->1", "2->2"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ realPoId: 3, reason: "no-vendor-match" });
  });
});
