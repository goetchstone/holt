// /app/__tests__/historicalPoSiblings.test.ts
//
// Pure-helper tests for the sibling-PO scoring + ranking used after a
// historical PO import. No I/O — the helper takes hydrated candidates
// and returns the ranked list.

import {
  scoreSiblings,
  type SiblingCandidate,
  type SiblingSource,
} from "@/lib/historicalPoSiblings";

function candidate(overrides: Partial<SiblingCandidate> = {}): SiblingCandidate {
  return {
    id: 200,
    poNumber: "PON20001",
    orderDate: new Date(Date.UTC(2025, 9, 20)),
    vendorId: 42,
    vendorName: "Wesley Hall",
    status: "RECEIVED_FULL",
    lineCount: 3,
    partNos: ["WH-1001", "WH-1002", "WH-1003"],
    alreadyImportedToBuyId: null,
    ...overrides,
  };
}

describe("scoreSiblings", () => {
  it("returns empty when no candidates supplied", () => {
    expect(scoreSiblings({ id: 100, partNos: ["A"] }, [])).toEqual([]);
  });

  it("excludes the source itself by id", () => {
    const source: SiblingSource = { id: 100, partNos: ["WH-1001"] };
    const result = scoreSiblings(source, [
      candidate({ id: 100, partNos: ["WH-1001"] }), // source — should be filtered
      candidate({ id: 200, partNos: ["WH-1001"] }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(200);
  });

  it("excludes candidates already imported into a buy", () => {
    const source: SiblingSource = { id: 100, partNos: ["WH-1001"] };
    const result = scoreSiblings(source, [
      candidate({ id: 200, partNos: ["WH-1001"], alreadyImportedToBuyId: 5 }),
      candidate({ id: 201, partNos: ["WH-1001"], alreadyImportedToBuyId: null }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(201);
  });

  it("excludes candidates with zero partNo overlap (different buy entirely)", () => {
    const source: SiblingSource = { id: 100, partNos: ["WH-1001", "WH-1002"] };
    const result = scoreSiblings(source, [
      candidate({ id: 200, partNos: ["WH-1001"] }), // overlap = 1, kept
      candidate({ id: 201, partNos: ["CRL-9999"] }), // overlap = 0, dropped
      candidate({ id: 202, partNos: ["WH-1002", "CRL-1234"] }), // overlap = 1, kept
    ]);
    expect(result.map((s) => s.id).sort()).toEqual([200, 202]);
  });

  it("counts overlap by distinct partNo (duplicates within a PO don't inflate)", () => {
    const source: SiblingSource = { id: 100, partNos: ["WH-1001", "WH-1002"] };
    const result = scoreSiblings(source, [
      candidate({ id: 200, partNos: ["WH-1001", "WH-1001", "WH-1001"] }),
    ]);
    expect(result[0].overlapCount).toBe(1);
  });

  it("flags fully-contained candidates (likely remainder POs)", () => {
    const source: SiblingSource = { id: 100, partNos: ["A", "B", "C", "D"] };
    const result = scoreSiblings(source, [
      candidate({ id: 200, partNos: ["A", "B"] }), // fully contained
      candidate({ id: 201, partNos: ["A", "Z"] }), // partial (has Z that source doesn't)
    ]);
    const c200 = result.find((s) => s.id === 200);
    const c201 = result.find((s) => s.id === 201);
    expect(c200?.fullyContainedBySource).toBe(true);
    expect(c201?.fullyContainedBySource).toBe(false);
  });

  it("sorts by overlapCount DESC, then fullyContained DESC, then orderDate ASC", () => {
    const source: SiblingSource = { id: 100, partNos: ["A", "B", "C", "D"] };
    const result = scoreSiblings(source, [
      candidate({
        id: 200,
        partNos: ["A"],
        orderDate: new Date(Date.UTC(2025, 0, 1)),
      }), // overlap 1
      candidate({
        id: 201,
        partNos: ["A", "B"],
        orderDate: new Date(Date.UTC(2025, 6, 1)),
      }), // overlap 2 fully contained
      candidate({
        id: 202,
        partNos: ["A", "B", "Z"],
        orderDate: new Date(Date.UTC(2025, 3, 1)),
      }), // overlap 2 NOT fully contained
      candidate({
        id: 203,
        partNos: ["A", "B"],
        orderDate: new Date(Date.UTC(2025, 1, 1)),
      }), // overlap 2 fully contained EARLIER
    ]);
    expect(result.map((s) => s.id)).toEqual([203, 201, 202, 200]);
    //                                          ^^^^^^^^^^ tie: both overlap=2 + fully contained, earlier first
    //                                                ^^^ overlap 2 + not fully contained
    //                                                     ^^^ overlap 1
  });

  it("handles a candidate with empty partNos array (skipped, no overlap possible)", () => {
    const source: SiblingSource = { id: 100, partNos: ["A"] };
    const result = scoreSiblings(source, [candidate({ id: 200, partNos: [] })]);
    expect(result).toEqual([]);
  });

  it("handles a source with empty partNos array (no overlap possible with anything)", () => {
    const source: SiblingSource = { id: 100, partNos: [] };
    const result = scoreSiblings(source, [
      candidate({ id: 200, partNos: ["A"] }),
      candidate({ id: 201, partNos: ["B"] }),
    ]);
    expect(result).toEqual([]);
  });

  it("handles null partNos in candidate input (filtered upstream — helper assumes non-null strings)", () => {
    // The API handler is responsible for filtering out null partNos before
    // calling this helper. Test the helper assumes the contract is honored.
    const source: SiblingSource = { id: 100, partNos: ["A"] };
    const result = scoreSiblings(source, [candidate({ id: 200, partNos: ["A"] })]);
    expect(result).toHaveLength(1);
    expect(result[0].overlapCount).toBe(1);
  });

  it("preserves all candidate fields in the scored output", () => {
    const result = scoreSiblings({ id: 100, partNos: ["A"] }, [
      candidate({
        id: 200,
        poNumber: "PON-X",
        vendorName: "Test Vendor",
        status: "RECEIVED_FULL",
        lineCount: 5,
        partNos: ["A", "B"],
      }),
    ]);
    expect(result[0].poNumber).toBe("PON-X");
    expect(result[0].vendorName).toBe("Test Vendor");
    expect(result[0].status).toBe("RECEIVED_FULL");
    expect(result[0].lineCount).toBe(5);
    expect(result[0].overlapCount).toBe(1);
  });

  it("treats partial-receive remainder shape correctly (small overlap, fully contained, after source)", () => {
    // Realistic scenario: source PON12345 had 5 items. Partial-receive
    // moved 2 items to remainder PON12346 (created 30 days later, same
    // vendor). The remainder should rank as a strong candidate.
    const source: SiblingSource = {
      id: 1000,
      partNos: ["WH-A", "WH-B", "WH-C", "WH-D", "WH-E"],
    };
    const remainder = candidate({
      id: 1001,
      poNumber: "PON12346",
      partNos: ["WH-D", "WH-E"],
      orderDate: new Date(Date.UTC(2026, 0, 15)),
    });
    const unrelated = candidate({
      id: 1002,
      poNumber: "PON99999",
      partNos: ["WH-A", "CRL-2000"],
      orderDate: new Date(Date.UTC(2026, 1, 1)),
    });

    const result = scoreSiblings(source, [remainder, unrelated]);
    expect(result[0].id).toBe(1001); // remainder ranks first
    expect(result[0].fullyContainedBySource).toBe(true);
    expect(result[0].overlapCount).toBe(2);
    expect(result[1].id).toBe(1002);
    expect(result[1].fullyContainedBySource).toBe(false);
  });
});
