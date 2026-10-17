// /app/__tests__/receiptPage.test.ts
//
// The receipt's printed page. `size: 80mm auto` was invalid CSS, so the browser
// dropped it and the global landscape-Letter rule printed every receipt PDF on
// an 11x8.5 sheet. The rule must always be two lengths.

import { receiptHeightMm, receiptPageRule, RECEIPT_WIDTH_PX, wrapText } from "@/lib/receiptPage";

describe("receiptPageRule", () => {
  it("asks for an 80mm-wide page exactly as long as the receipt", () => {
    // 1,200 canvas pixels at 640px per 80mm is 150mm of paper.
    expect(receiptPageRule(1200)).toBe("@page { margin: 0; size: 80mm 150mm; }");
  });

  it("never mixes a length with auto, which browsers discard", () => {
    for (const px of [1, 333, 640, 1999, 5000]) {
      const rule = receiptPageRule(px);
      expect(rule).not.toMatch(/auto/);
      expect(rule).toMatch(/size: 80mm \d+(\.\d)?mm;/);
    }
  });

  it("rounds up, so the last line never spills onto a second page", () => {
    // 641px is 80.125mm; rounding down to 80.1 would clip the bottom row.
    expect(receiptHeightMm(641)).toBe(80.2);
    expect(receiptHeightMm(RECEIPT_WIDTH_PX)).toBe(80);
  });
});

describe("wrapText", () => {
  // One unit per character, so widths are easy to reason about.
  const measure = (t: string) => t.length;

  it("breaks between words so no line runs past the paper", () => {
    expect(wrapText(measure, "Returns within thirty days with receipt", 16)).toEqual([
      "Returns within",
      "thirty days with",
      "receipt",
    ]);
  });

  it("keeps the store's own line breaks", () => {
    expect(wrapText(measure, "Final sale on custom orders.\nThank you!", 40)).toEqual([
      "Final sale on custom orders.",
      "Thank you!",
    ]);
  });

  it("puts an over-long word on its own line rather than dropping it", () => {
    expect(wrapText(measure, "see holt.example.com/returns-policy today", 10)).toEqual([
      "see",
      "holt.example.com/returns-policy",
      "today",
    ]);
  });
});
