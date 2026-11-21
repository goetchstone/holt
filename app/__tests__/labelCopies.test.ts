// Rule 14: the copies guard is pure. It is the one guard on every label print
// path (rule 42), so a bad value never reaches `zpl.repeat`.
import fc from "fast-check";
import {
  MAX_TAG_COPIES,
  boundedTagCopies,
  receivedTagCopies,
  receivedTagsShortNote,
  tagCopiesProblem,
} from "@/lib/labels/tagCopies";

describe("tagCopiesProblem", () => {
  it("accepts 1 through the maximum", () => {
    expect(tagCopiesProblem(1)).toBeNull();
    expect(tagCopiesProblem(MAX_TAG_COPIES)).toBeNull();
  });

  it.each([
    ["non-integer", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["zero", 0],
    ["negative", -1],
    ["max + 1", MAX_TAG_COPIES + 1],
    ["huge", 1e9],
    ["numeric string", "2"],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s with a message that says what was wrong", (_n, value) => {
    expect(tagCopiesProblem(value)).toMatch(/whole number from 1 to 10/);
  });
});

describe("boundedTagCopies", () => {
  it("returns the value itself when it is in range", () => {
    expect(boundedTagCopies(1)).toBe(1);
    expect(boundedTagCopies(MAX_TAG_COPIES)).toBe(MAX_TAG_COPIES);
  });

  it.each([0, MAX_TAG_COPIES + 1, 1e9, 1.5, NaN, Infinity, "2", null])(
    "returns null for %p, never a clamped number",
    (value) => {
      expect(boundedTagCopies(value)).toBeNull();
    },
  );
});

// Receiving asked the batch print for the quantity received as copies, so from
// #127 a line of more than ten, or a part roll, printed none of its tags.
describe("receivedTagCopies (the Receive PO screen's tag print)", () => {
  it.each([
    [1, 1, 0],
    [7, 7, 0],
    [MAX_TAG_COPIES, MAX_TAG_COPIES, 0],
    [14, MAX_TAG_COPIES, 4],
    [30, MAX_TAG_COPIES, 20],
  ])("%p pieces received ask for %p tags and leave %p to print", (quantity, copies, untagged) => {
    expect(receivedTagCopies(quantity)).toEqual({ copies, untagged });
  });

  // A fractional quantity can only be a length: a part roll of fabric or
  // wallpaper, received as 12.5 yards (lib/inventory/qtyInput.ts; schema.prisma,
  // InventoryPosition.quantity). It is one item, so it gets one tag, and nothing
  // is left to print for it.
  it.each([12.5, 2.5, 0.25, 12.625])("%p received, a length, asks for one tag", (quantity) => {
    expect(receivedTagCopies(quantity)).toEqual({ copies: 1, untagged: 0 });
  });

  it("asks for copies the bound accepts for any quantity a receipt holds", () => {
    // parseQty keeps a received quantity positive, to three places.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (thousandths) => {
        const quantity = thousandths / 1000;
        const { copies, untagged } = receivedTagCopies(quantity);
        expect(boundedTagCopies(copies)).toBe(copies);
        // One tag per piece of a count; one for a length, which is one item.
        expect(copies + untagged).toBe(Number.isInteger(quantity) ? quantity : 1);
      }),
    );
  });
});

describe("receivedTagsShortNote", () => {
  it("says nothing when every piece got its tag", () => {
    expect(receivedTagsShortNote([{ name: "Sofa", ...receivedTagCopies(4) }])).toBeNull();
    expect(receivedTagsShortNote([])).toBeNull();
  });

  it("names each line left with pieces to tag, and where to print the rest", () => {
    expect(
      receivedTagsShortNote([
        { name: "Sofa", ...receivedTagCopies(14) },
        { name: "Lamp", ...receivedTagCopies(2) },
        { name: "Chair", ...receivedTagCopies(30) },
      ]),
    ).toBe(
      "Sofa: 10 tags printed, 4 still to print; Chair: 10 tags printed, 20 still to print. " +
        "A print takes at most 10 of one tag, so print the rest from the product's page.",
    );
  });

  it("asks for no more tags for a part roll: its one tag is all it needs", () => {
    expect(receivedTagsShortNote([{ name: "Linen", ...receivedTagCopies(12.5) }])).toBeNull();
  });
});
