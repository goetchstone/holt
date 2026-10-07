// /app/__tests__/buyerDraftAutoFulfillPo.test.ts
//
// A-grade tests for the Slice 6.10 auto-fulfill planner. Pure
// branching logic, no I/O.

import { planAutoFulfill, type DraftPoForAutoFulfill } from "@/lib/buyerDraftAutoFulfillPo";

describe("planAutoFulfill — eligibility", () => {
  const po = (
    id: number,
    status: string,
    items: Array<{ fulfilledProductId: number | null }>,
  ): DraftPoForAutoFulfill => ({ id, status, items });

  it("flips a DRAFT PO whose every linked item is in receivedProductIds", () => {
    const result = planAutoFulfill(
      [po(1, "DRAFT", [{ fulfilledProductId: 100 }, { fulfilledProductId: 200 }])],
      new Set([100, 200]),
    );
    expect(result.draftPoIdsToFulfill).toEqual([1]);
    expect(result.draftPoIdsSkipped).toEqual([]);
  });

  it("flips READY and EXPORTED POs too (they're all pre-fulfilled states)", () => {
    const result = planAutoFulfill(
      [
        po(1, "READY", [{ fulfilledProductId: 100 }]),
        po(2, "EXPORTED", [{ fulfilledProductId: 200 }]),
      ],
      new Set([100, 200]),
    );
    expect(result.draftPoIdsToFulfill.sort()).toEqual([1, 2]);
  });

  it("skips an already-FULFILLED PO (idempotent — no churn)", () => {
    const result = planAutoFulfill(
      [po(1, "FULFILLED", [{ fulfilledProductId: 100 }])],
      new Set([100]),
    );
    expect(result.draftPoIdsToFulfill).toEqual([]);
    expect(result.draftPoIdsSkipped).toEqual([1]);
  });

  it("skips a CANCELLED PO even if products are received (buyer's intent stands)", () => {
    const result = planAutoFulfill(
      [po(1, "CANCELLED", [{ fulfilledProductId: 100 }])],
      new Set([100]),
    );
    expect(result.draftPoIdsToFulfill).toEqual([]);
    expect(result.draftPoIdsSkipped).toEqual([1]);
  });

  it("skips a PO with NO linked items (can't verify, conservative)", () => {
    const result = planAutoFulfill(
      [
        po(1, "DRAFT", []),
        po(2, "DRAFT", [{ fulfilledProductId: null }, { fulfilledProductId: null }]),
      ],
      new Set([100, 200]),
    );
    expect(result.draftPoIdsToFulfill).toEqual([]);
    expect(result.draftPoIdsSkipped.sort()).toEqual([1, 2]);
  });

  it("skips a PO when at least one linked item is NOT yet received", () => {
    const result = planAutoFulfill(
      [po(1, "DRAFT", [{ fulfilledProductId: 100 }, { fulfilledProductId: 200 }])],
      new Set([100]), // only 100 received; 200 missing
    );
    expect(result.draftPoIdsToFulfill).toEqual([]);
    expect(result.draftPoIdsSkipped).toEqual([1]);
  });

  it("tolerates unlinked items mixed in — only linked items need to be received", () => {
    // Real-world case: buyer drafted 3 items, 2 got linked and arrived,
    // 1 was net-new and not yet in the POS. The PO is fulfilled
    // enough for our purposes — the unlinked item is a separate
    // tracking concern, not a blocker.
    const result = planAutoFulfill(
      [
        po(1, "DRAFT", [
          { fulfilledProductId: 100 },
          { fulfilledProductId: 200 },
          { fulfilledProductId: null }, // unlinked — tolerated
        ]),
      ],
      new Set([100, 200]),
    );
    expect(result.draftPoIdsToFulfill).toEqual([1]);
  });

  it("returns empty plan for empty input", () => {
    const result = planAutoFulfill([], new Set([100]));
    expect(result.draftPoIdsToFulfill).toEqual([]);
    expect(result.draftPoIdsSkipped).toEqual([]);
  });

  it("handles multiple POs in one pass (some eligible, some not)", () => {
    const result = planAutoFulfill(
      [
        po(1, "DRAFT", [{ fulfilledProductId: 100 }]), // eligible
        po(2, "DRAFT", [{ fulfilledProductId: 200 }]), // 200 not received
        po(3, "FULFILLED", [{ fulfilledProductId: 100 }]), // already done
        po(4, "DRAFT", [{ fulfilledProductId: 300 }]), // eligible
      ],
      new Set([100, 300]),
    );
    expect(result.draftPoIdsToFulfill.sort()).toEqual([1, 4]);
    expect(result.draftPoIdsSkipped.sort()).toEqual([2, 3]);
  });
});
