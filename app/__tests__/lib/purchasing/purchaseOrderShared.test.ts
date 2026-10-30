// /app/__tests__/lib/purchasing/purchaseOrderShared.test.ts
//
// GAP-01: the rules the PO editor and the server share -- what a PO body must
// carry, when a PO can still be changed, and a line's cost.

import {
  parseNewPo,
  parsePoDraft,
  poEditProblem,
  poLineTotal,
  MAX_PO_NOTES,
} from "@/lib/purchasing/purchaseOrderShared";

const draft = {
  shipToLocationId: 3,
  expectedDelivery: "2026-11-20",
  notes: "  Dock door 2  ",
  lines: [{ productId: 7, quantity: 2, unitCost: 410.5 }],
};

describe("parsePoDraft", () => {
  it("reads a well-formed body, trimming notes and keeping each line's id when it has one", () => {
    const parsed = parsePoDraft({
      ...draft,
      lines: [...draft.lines, { id: 12, productId: 8, quantity: 1.5 }],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        shipToLocationId: 3,
        expectedDelivery: "2026-11-20",
        notes: "Dock door 2",
        lines: [
          { productId: 7, quantity: 2, unitCost: 410.5 },
          { id: 12, productId: 8, quantity: 1.5, unitCost: null },
        ],
      },
    });
  });

  it("takes an empty date and empty notes as none", () => {
    const parsed = parsePoDraft({ ...draft, expectedDelivery: "", notes: "   " });
    expect(parsed).toMatchObject({ ok: true, value: { expectedDelivery: null, notes: null } });
  });

  it.each([
    [{ ...draft, shipToLocationId: null }, "Choose where the vendor delivers."],
    [{ ...draft, expectedDelivery: "next week" }, "The expected date must be a date."],
    [{ ...draft, expectedDelivery: "2026-13-45" }, "The expected date must be a date."],
    [{ ...draft, notes: 5 }, "Notes must be text."],
    [
      { ...draft, notes: "x".repeat(MAX_PO_NOTES + 1) },
      `Notes can be at most ${MAX_PO_NOTES} characters.`,
    ],
    [{ ...draft, lines: [] }, "Add at least one line."],
    [{ ...draft, lines: [{ productId: 0, quantity: 1 }] }, "Line 1: choose a product."],
    [
      { ...draft, lines: [{ productId: 7, quantity: 0 }] },
      "Line 1: the quantity must be more than 0.",
    ],
    [
      { ...draft, lines: [{ productId: 7, quantity: -1 }] },
      "Line 1: the quantity must be more than 0.",
    ],
    [
      { ...draft, lines: [{ productId: 7, quantity: "2" }] },
      "Line 1: the quantity must be more than 0.",
    ],
    [
      { ...draft, lines: [{ productId: 7, quantity: 1, unitCost: -5 }] },
      "Line 1: the unit cost can't be negative.",
    ],
    [
      { ...draft, lines: [draft.lines[0], { id: "x", productId: 7, quantity: 1 }] },
      "Line 2: not a line on this PO.",
    ],
  ])("refuses %j", (body, problem) => {
    expect(parsePoDraft(body)).toEqual({ ok: false, problem });
  });
});

describe("parseNewPo", () => {
  it("needs a vendor, then reads the rest as a draft", () => {
    expect(parseNewPo(draft)).toEqual({ ok: false, problem: "Choose a vendor." });
    expect(parseNewPo({ ...draft, vendorId: 4 })).toMatchObject({
      ok: true,
      value: { vendorId: 4, shipToLocationId: 3 },
    });
  });
});

describe("poEditProblem", () => {
  it("lets a draft, a submitted and a confirmed PO change while nothing is received", () => {
    for (const status of ["DRAFT", "SUBMITTED", "CONFIRMED"]) {
      expect(poEditProblem({ status, isReturn: false, receivedCount: 0 })).toBeNull();
    }
  });

  it("refuses once anything is received, whatever the status", () => {
    expect(poEditProblem({ status: "CONFIRMED", isReturn: false, receivedCount: 1 })).toBe(
      "This PO can't be changed: goods have been received against it.",
    );
  });

  it("refuses a closed PO and a vendor return", () => {
    for (const status of ["CANCELLED", "RECEIVED_FULL", "SHORT_CLOSED"]) {
      expect(poEditProblem({ status, isReturn: false, receivedCount: 0 })).toBe(
        "This PO is closed and can't be changed.",
      );
    }
    expect(poEditProblem({ status: "DRAFT", isReturn: true, receivedCount: 0 })).toBe(
      "A vendor return can't be changed here.",
    );
  });
});

describe("poLineTotal", () => {
  it("is quantity times unit cost, to the cent", () => {
    expect(poLineTotal(3, 19.99)).toBe(59.97);
    expect(poLineTotal(1.5, 10.005)).toBe(15.01);
  });
});
