// /app/__tests__/buyerDraftDnd.test.ts
//
// A-grade tests for the pure parseDragIds helper. Pinned: every valid
// transition shape, every reject path (bad prefix, NaN id, missing over).

import { parseDragIds } from "@/lib/buyerDraftDnd";

describe("parseDragIds", () => {
  describe("item → PO", () => {
    test("item-5 over po-12 → item-to-po(5, 12)", () => {
      expect(parseDragIds("item-5", "po-12")).toEqual({
        kind: "item-to-po",
        itemId: 5,
        nextPoId: 12,
      });
    });

    test("item-5 over po-unassigned → item-to-po(5, null)", () => {
      expect(parseDragIds("item-5", "po-unassigned")).toEqual({
        kind: "item-to-po",
        itemId: 5,
        nextPoId: null,
      });
    });

    test("item-5 over buy-9 → null (item never moves directly to buy)", () => {
      expect(parseDragIds("item-5", "buy-9")).toBeNull();
    });

    test("item-NaN over po-12 → null", () => {
      expect(parseDragIds("item-abc", "po-12")).toBeNull();
    });

    test("item-5 over po-NaN → null", () => {
      expect(parseDragIds("item-5", "po-abc")).toBeNull();
    });
  });

  describe("PO → Buy", () => {
    test("po-7 over buy-3 → po-to-buy(7, 3)", () => {
      expect(parseDragIds("po-7", "buy-3")).toEqual({
        kind: "po-to-buy",
        poId: 7,
        nextBuyId: 3,
      });
    });

    test("po-7 over buy-unassigned → po-to-buy(7, null)", () => {
      expect(parseDragIds("po-7", "buy-unassigned")).toEqual({
        kind: "po-to-buy",
        poId: 7,
        nextBuyId: null,
      });
    });

    test("po-7 over po-12 → null (PO can't drop on another PO)", () => {
      expect(parseDragIds("po-7", "po-12")).toBeNull();
    });

    test("po-NaN over buy-3 → null", () => {
      expect(parseDragIds("po-abc", "buy-3")).toBeNull();
    });

    test("po-7 over buy-NaN → null", () => {
      expect(parseDragIds("po-7", "buy-abc")).toBeNull();
    });
  });

  describe("rejects", () => {
    test("bare number active → null", () => {
      expect(parseDragIds("5", "po-12")).toBeNull();
    });

    test("unknown prefix active → null", () => {
      expect(parseDragIds("widget-1", "po-12")).toBeNull();
    });

    test("empty strings → null", () => {
      expect(parseDragIds("", "")).toBeNull();
    });
  });
});
