// /app/__tests__/duplicateQuotes.test.ts

import { detectPossibleDuplicates } from "../src/lib/duplicateQuotes";

function mkQuote(
  id: number,
  orderno: string,
  customerId: number,
  items: { partNo: string | null; netPrice: number }[],
  archived = false,
  salesPersonId: number | null = null,
) {
  return {
    id,
    orderno,
    customer: { id: customerId },
    lineItems: items,
    pipelineArchivedAt: archived ? new Date() : null,
    salesPersonId,
  };
}

describe("detectPossibleDuplicates", () => {
  it("returns empty when there is nothing to compare", () => {
    expect(detectPossibleDuplicates([]).size).toBe(0);
    expect(
      detectPossibleDuplicates([mkQuote(1, "SO-1", 1, [{ partNo: "A", netPrice: 500 }])]).size,
    ).toBe(0);
  });

  it("does not pair quotes from different customers", () => {
    const a = mkQuote(1, "SO-1", 1, [{ partNo: "A", netPrice: 500 }]);
    const b = mkQuote(2, "SO-2", 2, [{ partNo: "A", netPrice: 500 }]);
    expect(detectPossibleDuplicates([a, b]).size).toBe(0);
  });

  it("flags quotes with >=50% shared part numbers", () => {
    const a = mkQuote(1, "SO-1", 1, [
      { partNo: "A", netPrice: 100 },
      { partNo: "B", netPrice: 200 },
    ]);
    const b = mkQuote(2, "SO-2", 1, [
      { partNo: "A", netPrice: 100 },
      { partNo: "B", netPrice: 250 },
      { partNo: "C", netPrice: 50 },
    ]);
    const result = detectPossibleDuplicates([a, b]);
    // 2 shared / max(2, 3) = 0.66 → over 0.5 threshold
    expect(result.get(1)).toEqual([{ id: 2, orderno: "SO-2" }]);
    expect(result.get(2)).toEqual([{ id: 1, orderno: "SO-1" }]);
  });

  it("does not flag quotes with <50% overlap and dissimilar totals", () => {
    const a = mkQuote(1, "SO-1", 1, [
      { partNo: "A", netPrice: 50 },
      { partNo: "B", netPrice: 50 },
      { partNo: "C", netPrice: 50 },
      { partNo: "D", netPrice: 50 },
    ]);
    const b = mkQuote(2, "SO-2", 1, [
      { partNo: "A", netPrice: 5000 },
      { partNo: "E", netPrice: 5000 },
    ]);
    // 1 shared / max(4, 2) = 0.25, totals $200 vs $10000 — no flag
    expect(detectPossibleDuplicates([a, b]).size).toBe(0);
  });

  it("flags quotes with dissimilar parts but similar totals >= $100", () => {
    const a = mkQuote(1, "SO-1", 1, [{ partNo: "A", netPrice: 500 }]);
    const b = mkQuote(2, "SO-2", 1, [{ partNo: "B", netPrice: 520 }]);
    // 0 shared, but totals within 10% ($500 vs $520 → 3.8%)
    const result = detectPossibleDuplicates([a, b]);
    expect(result.get(1)).toEqual([{ id: 2, orderno: "SO-2" }]);
  });

  it("does not flag similar totals below $100", () => {
    const a = mkQuote(1, "SO-1", 1, [{ partNo: "A", netPrice: 40 }]);
    const b = mkQuote(2, "SO-2", 1, [{ partNo: "B", netPrice: 42 }]);
    expect(detectPossibleDuplicates([a, b]).size).toBe(0);
  });

  it("ignores archived quotes entirely", () => {
    const a = mkQuote(1, "SO-1", 1, [{ partNo: "A", netPrice: 500 }]);
    const b = mkQuote(2, "SO-2", 1, [{ partNo: "A", netPrice: 500 }], true); // archived
    expect(detectPossibleDuplicates([a, b]).size).toBe(0);
  });

  it("treats part numbers case-insensitively", () => {
    const a = mkQuote(1, "SO-1", 1, [
      { partNo: "sofa-100", netPrice: 500 },
      { partNo: "chair-200", netPrice: 500 },
    ]);
    const b = mkQuote(2, "SO-2", 1, [
      { partNo: "SOFA-100", netPrice: 600 },
      { partNo: "CHAIR-200", netPrice: 600 },
    ]);
    expect(detectPossibleDuplicates([a, b]).get(1)).toHaveLength(1);
  });

  it("handles three duplicate quotes — transitive pairing", () => {
    const a = mkQuote(1, "SO-1", 1, [{ partNo: "A", netPrice: 500 }]);
    const b = mkQuote(2, "SO-2", 1, [{ partNo: "A", netPrice: 500 }]);
    const c = mkQuote(3, "SO-3", 1, [{ partNo: "A", netPrice: 500 }]);
    const result = detectPossibleDuplicates([a, b, c]);
    expect(result.get(1)).toHaveLength(2);
    expect(result.get(2)).toHaveLength(2);
    expect(result.get(3)).toHaveLength(2);
  });

  it("handles null part numbers gracefully", () => {
    const a = mkQuote(1, "SO-1", 1, [{ partNo: null, netPrice: 500 }]);
    const b = mkQuote(2, "SO-2", 1, [{ partNo: null, netPrice: 520 }]);
    // No part numbers to compare, but totals are similar
    const result = detectPossibleDuplicates([a, b]);
    expect(result.get(1)).toEqual([{ id: 2, orderno: "SO-2" }]);
  });

  // Salesperson exclusion (Issue #129): same customer + different
  // designer is treated as a customer transfer, not a duplicate. The
  // detector declines to surface those pairs so the UI can't surface
  // an "archive me" affordance against a legitimate new quote.
  describe("salesperson exclusion (Issue #129)", () => {
    it("does NOT flag matching quotes when salesPersonIds differ", () => {
      // Mirrors the SO-38985 / SO-36936 case: same customer, same
      // products, two different designers.
      const a = mkQuote(
        1,
        "SO-AMY",
        10106,
        [{ partNo: "AL-KAD-RO3-ST", netPrice: 7575 }],
        false,
        2, // Amy
      );
      const b = mkQuote(
        2,
        "SO-KIM",
        10106,
        [{ partNo: "AL-KAD-RO3-ST", netPrice: 7575 }],
        false,
        7, // Kim
      );
      const result = detectPossibleDuplicates([a, b]);
      expect(result.size).toBe(0);
    });

    it("DOES still flag matching quotes when both have the same salesPersonId", () => {
      const a = mkQuote(1, "SO-1", 10106, [{ partNo: "A", netPrice: 500 }], false, 2);
      const b = mkQuote(2, "SO-2", 10106, [{ partNo: "A", netPrice: 500 }], false, 2);
      const result = detectPossibleDuplicates([a, b]);
      expect(result.get(1)).toEqual([{ id: 2, orderno: "SO-2" }]);
    });

    it("flags pairs when one quote's salesPersonId is null (legacy data)", () => {
      // Legacy quotes pre-dating salesPersonId tracking should still be
      // checkable -- only flip the exclusion when BOTH sides have an id.
      const a = mkQuote(
        1,
        "SO-OLD",
        10106,
        [{ partNo: "A", netPrice: 500 }],
        false,
        null, // unknown / legacy
      );
      const b = mkQuote(2, "SO-NEW", 10106, [{ partNo: "A", netPrice: 500 }], false, 7);
      const result = detectPossibleDuplicates([a, b]);
      expect(result.get(1)).toEqual([{ id: 2, orderno: "SO-NEW" }]);
    });

    it("flags pairs when both salesPersonIds are missing", () => {
      const a = mkQuote(1, "SO-1", 10106, [{ partNo: "A", netPrice: 500 }]);
      const b = mkQuote(2, "SO-2", 10106, [{ partNo: "A", netPrice: 500 }]);
      const result = detectPossibleDuplicates([a, b]);
      expect(result.get(1)).toEqual([{ id: 2, orderno: "SO-2" }]);
    });
  });
});
