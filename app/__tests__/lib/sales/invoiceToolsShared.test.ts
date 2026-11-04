// /app/__tests__/lib/sales/invoiceToolsShared.test.ts
//
// GAP-07: the small rules the invoice tools' server and screens share -- what a
// line note may be, which flags warn on opening and in what order flags draw,
// which picture a line prints, and when an order's disclaimers may change.

import { LINE_NOTE_MAX, readLineNote } from "@/lib/sales/lineNotesShared";
import {
  flagRefsOf,
  isOrderFlagColor,
  openingAlerts,
  orderFlagChipClasses,
} from "@/lib/sales/orderFlagsShared";
import { linePictureUrl } from "@/lib/sales/linePicture";
import { disclaimerEditProblem } from "@/lib/sales/orderDisclaimersShared";

describe("readLineNote", () => {
  it("trims a note, and stores an empty one as no note", () => {
    expect(readLineNote("  Legs in walnut ")).toEqual({ note: "Legs in walnut" });
    expect(readLineNote("   ")).toEqual({ note: null });
    expect(readLineNote(null)).toEqual({ note: null });
  });

  it("refuses a note that isn't text or is too long", () => {
    expect(readLineNote(undefined)).toEqual({ problem: expect.stringMatching(/text, or null/) });
    expect(readLineNote(5)).toEqual({ problem: expect.stringMatching(/text, or null/) });
    expect(readLineNote("x".repeat(LINE_NOTE_MAX))).toEqual({ note: "x".repeat(LINE_NOTE_MAX) });
    expect(readLineNote("x".repeat(LINE_NOTE_MAX + 1))).toEqual({
      problem: expect.stringMatching(/under 500/),
    });
  });
});

describe("order flags", () => {
  const flag = (id: number, name: string, sortOrder: number, alertOnOpen = false) => ({
    orderFlag: { id, name, color: "red", alertOnOpen, sortOrder },
  });

  it("draws an order's flags in the store's order, then by name", () => {
    expect(
      flagRefsOf([flag(1, "VIP", 2), flag(2, "Fragile", 1), flag(3, "Call", 1)]).map((f) => f.name),
    ).toEqual(["Call", "Fragile", "VIP"]);
    expect(flagRefsOf(undefined)).toEqual([]);
    expect(flagRefsOf([flag(1, "VIP", 2)])).toEqual([
      { id: 1, name: "VIP", color: "red", alertOnOpen: false },
    ]);
  });

  it("warns on opening only with the flags set to", () => {
    const refs = flagRefsOf([flag(1, "VIP", 0), flag(2, "Balance due", 1, true)]);
    expect(openingAlerts(refs).map((f) => f.name)).toEqual(["Balance due"]);
  });

  it("knows its colours, and draws one it doesn't know as grey", () => {
    expect([isOrderFlagColor("amber"), isOrderFlagColor("pink"), isOrderFlagColor(3)]).toEqual([
      true,
      false,
      false,
    ]);
    expect(orderFlagChipClasses("pink")).toBe(orderFlagChipClasses("gray"));
    expect(orderFlagChipClasses("red")).toMatch(/bg-red-100/);
  });
});

describe("linePictureUrl", () => {
  const pic = (imageUrl: string | null) => ({ imageUrl });

  it("prints the product's picture, else the line's style's, else the product's style's", () => {
    expect(
      linePictureUrl({
        product: { ...pic("/p.png"), vendorStyle: pic("/ps.png") },
        vendorStyle: pic("/ls.png"),
      }),
    ).toBe("/p.png");
    expect(
      linePictureUrl({
        product: { ...pic(null), vendorStyle: pic("/ps.png") },
        vendorStyle: pic("/ls.png"),
      }),
    ).toBe("/ls.png");
    expect(linePictureUrl({ product: { ...pic(""), vendorStyle: pic("/ps.png") } })).toBe(
      "/ps.png",
    );
    expect(linePictureUrl({ product: null, vendorStyle: null })).toBeNull();
  });
});

describe("disclaimerEditProblem", () => {
  it("lets a quote or an order change its disclaimers, and nothing after", () => {
    expect([disclaimerEditProblem("QUOTE"), disclaimerEditProblem("ORDER")]).toEqual([null, null]);
    expect(disclaimerEditProblem("FULFILLED")).toMatch(/handed over/);
    expect(disclaimerEditProblem("CANCELLED")).toMatch(/cancelled/);
  });
});
