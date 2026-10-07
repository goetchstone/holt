// /app/__tests__/sameDayRewriteCleanup.test.ts
//
// A-grade tests for `findDroppedBaseLineIds`. No DB, no I/O.
//
// Rewritten after an over-cancellation incident.
// The old `lineNumber > max(rewrite.lineNumber)` proxy was replaced
// with a combined heuristic: lineNumber positional check + consumption-
// based partNo matching against return AND rewrite. Tests pin both
// the canonical drop case (which still works) and the credit-cycle
// shape that broke the old logic — plus the consumption edge case
// (the canonical case's two-DELIVERY-CHARGE pattern).

import {
  findDroppedBaseLineIds,
  type LineItemForCleanup,
} from "@/lib/adapters/ordorite/sameDayRewriteCleanup";

function line(
  id: number,
  partNo: string | null,
  orderedQuantity: number,
  lineNumber: number | null = null,
  lineItemStatus = "ACTIVE",
): LineItemForCleanup {
  return { id, lineNumber, lineItemStatus, partNo, orderedQuantity };
}

describe("findDroppedBaseLineIds — combined heuristic with consumption", () => {
  it("canonical drop case: dropped items past rewrite footprint with no match → cancel", () => {
    // Base 5 lines: ITEM-A, ITEM-B, DELIVERY (kept), ITEM-C (dropped), DELIVERY (dropped extra)
    // Return 3 lines: ITEM-A -3, ITEM-B -1, DELIVERY -1
    // Rewrite 3 lines: ITEM-A, ITEM-B, DELIVERY
    // Expected: lines 4 (ITEM-C) and 5 (extra DELIVERY) cancelled.
    const baseLines = [
      line(101, "ITEM-A", 3, 1),
      line(102, "ITEM-B", 1, 2),
      line(103, "DELIVERY", 1, 3),
      line(104, "ITEM-C", 2, 4), // dropped — no return, no rewrite
      line(105, "DELIVERY", 1, 5), // dropped — return + rewrite already consumed by line 3
    ];
    const returnLines = [
      line(201, "ITEM-A", -3, 1),
      line(202, "ITEM-B", -1, 2),
      line(203, "DELIVERY", -1, 3),
    ];
    const rewriteLines = [
      line(301, "ITEM-A", 3, 1),
      line(302, "ITEM-B", 1, 2),
      line(303, "DELIVERY", 1, 3),
    ];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines })).toEqual([104, 105]);
  });

  it("credit-cycle regression: kept-but-credit-cycled lines have returns → DON'T cancel", () => {
    // The incident shape:
    // Base 6 lines: duvet (kept, no cycle), shams (kept, no cycle),
    //               bed (return-only), storage (3-way), frame (3-way),
    //               fee (dropped sticky fee)
    // Return 3 lines: bed, storage, frame
    // Rewrite 2 lines: storage, frame
    //
    // Duvet + shams are protected by lineNumber footprint check.
    // The bed has a matching return → protected by consumption.
    // Storage + frame have return + rewrite → protected by consumption.
    // The fee has no return, no rewrite, and falls beyond the rewrite's
    // footprint (lineNumber 6 > rewriteMax 2) → dropped.
    const baseLines = [
      line(1, "DUVET-A", 1, 1), // duvet — within footprint
      line(2, "SHAMS-A", 2, 2), // shams — within footprint
      line(3, "BED-A", 1, 3), // return-only credit cycle
      line(4, "STORAGE-A", 1, 4), // 3-way credit cycle
      line(5, "FRAME-A", 1, 5), // 3-way credit cycle
      line(6, "FEE", 1, 6), // sticky fee — accepted under-count
    ];
    const returnLines = [
      line(101, "BED-A", -1, 1),
      line(102, "STORAGE-A", -1, 2),
      line(103, "FRAME-A", -1, 3),
    ];
    const rewriteLines = [line(201, "STORAGE-A", 1, 1), line(202, "FRAME-A", 1, 2)];
    // Only the fee (id=6) gets cancelled. Duvet, shams, the bed
    // (return-only), and the two credit-cycle pair stay ACTIVE.
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines })).toEqual([6]);
  });

  it("consumption: duplicate partNo on base splits one-kept / one-dropped", () => {
    // Two identical DELIVERY lines on base, only one on return + rewrite.
    // The lower-lineNumber one claims the slot (matched first); the
    // higher-lineNumber one is dropped.
    const baseLines = [
      line(1, "DELIVERY", 1, 1), // claims return + rewrite
      line(2, "DELIVERY", 1, 4), // no match left → drop (and beyond footprint)
    ];
    const returnLines = [line(101, "DELIVERY", -1, 1)];
    const rewriteLines = [line(201, "DELIVERY", 1, 1)];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines })).toEqual([2]);
  });

  it("lineNumber footprint: lines within rewrite range are auto-kept even without return/rewrite match", () => {
    // Base line at lineNumber 2 with no return/rewrite, but rewrite has
    // up to lineNumber 3. The positional check protects it (Ordorite
    // left an unchanged base line in place — common pattern for items
    // the customer kept identically and didn't need credit-cycled).
    const baseLines = [
      line(1, "UNCHANGED-ITEM", 1, 2), // within rewrite footprint
      line(2, "DROPPED-ITEM", 1, 4), // beyond footprint, no match
    ];
    const rewriteLines = [line(101, "OTHER-PRODUCT", 1, 1), line(102, "OTHER-PRODUCT-2", 1, 3)];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines: [] })).toEqual([2]);
  });

  it("return-only match (no rewrite): keep ACTIVE", () => {
    // Customer returned an item but didn't re-buy it. The return
    // alone is enough to protect the base line.
    const baseLines = [line(1, "SOFA", 2, 3)];
    const returnLines = [line(101, "SOFA", -2, 1)];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines: [], returnLines })).toEqual([]);
  });

  it("rewrite-only match (no return): keep ACTIVE", () => {
    // Price-adjustment rewrite without a refund cycle. Match on partNo.
    const baseLines = [line(1, "SOFA", 1, 3), line(2, "DROPPED", 1, 4)];
    const rewriteLines = [line(101, "SOFA", 1, 1)];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines: [] })).toEqual([2]);
  });

  it("partial-qty return: still consumes the slot (return exists for the partNo)", () => {
    // Conservative direction: if the customer returned ANY quantity
    // of a partNo, treat the base line as kept. We'd rather over-keep
    // (and let daily reconciliation flag minor variances) than over-
    // cancel and silently under-report sales.
    //
    // Note this requires a sign-inverted *equality* check today; a
    // partial-qty return won't match. Pinned here so the behavior is
    // explicit and any future loosening is a deliberate decision.
    const baseLines = [line(1, "SOFA", 2, 3)];
    const returnLines = [line(2, "SOFA", -1, 1)]; // partial return — doesn't match exactly
    const rewriteLines: LineItemForCleanup[] = [];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines })).toEqual([1]); // strict-match: cancelled
  });

  it("idempotent: already-CANCELLED lines aren't re-flagged", () => {
    const baseLines = [
      line(1, "A", 1, 3, "CANCELLED"),
      line(2, "B", 1, 4), // truly dropped, beyond footprint, no match
    ];
    expect(
      findDroppedBaseLineIds({
        baseLines,
        rewriteLines: [
          { id: 101, partNo: "X", orderedQuantity: 1, lineNumber: 1, lineItemStatus: "ACTIVE" },
        ],
        returnLines: [],
      }),
    ).toEqual([2]);
  });

  it("null partNo on base: conservative — leave ACTIVE", () => {
    const baseLines = [line(1, null, 1, 5)];
    expect(
      findDroppedBaseLineIds({
        baseLines,
        rewriteLines: [],
        returnLines: [],
      }),
    ).toEqual([]);
  });

  it("degenerate inputs: empty everything → empty result", () => {
    expect(findDroppedBaseLineIds({ baseLines: [], rewriteLines: [], returnLines: [] })).toEqual(
      [],
    );
  });

  it("no rewrite at all (rewriteMax = 0): every line is beyond footprint", () => {
    // If there's no rewrite, every base line falls beyond rewriteMax=0.
    // Without any returns/rewrites to claim, they all drop. This
    // shouldn't happen in practice (a rewrite-named order without
    // rewrite/return data is suspicious) but the helper handles it.
    const baseLines = [line(1, "A", 1, 1), line(2, "B", 1, 2)];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines: [], returnLines: [] })).toEqual([
      1, 2,
    ]);
  });

  it("paired consumption: a return match also claims the corresponding rewrite line", () => {
    // A 3-way credit cycle (return + rewrite for the same partNo) is
    // owned by ONE base line. A second base line with the same partNo
    // can't claim the leftover rewrite — it's already paired off.
    // This is what makes the canonical case's two-DELIVERY pattern work.
    const baseLines = [
      line(1, "ITEM", 1, 1), // claims BOTH return and rewrite (paired)
      line(2, "ITEM", 1, 5), // no match left, beyond footprint → drop
    ];
    const returnLines = [line(101, "ITEM", -1, 1)];
    const rewriteLines = [line(201, "ITEM", 1, 1)];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines })).toEqual([2]);
  });

  it("return-only with no paired rewrite: doesn't try to claim a rewrite slot", () => {
    // Return-only credit cycle: customer returned an item but didn't
    // re-buy it. There's no rewrite line to pair. A subsequent base
    // line with a different partNo can still claim its own rewrite.
    const baseLines = [
      line(1, "RETURNED-ITEM", 1, 1), // claims return only (no rewrite for this partNo)
      line(2, "REWRITTEN-ITEM", 1, 2), // claims rewrite (still available)
    ];
    const returnLines = [line(101, "RETURNED-ITEM", -1, 1)];
    const rewriteLines = [line(201, "REWRITTEN-ITEM", 1, 1)];
    expect(findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines })).toEqual([]);
  });
});
