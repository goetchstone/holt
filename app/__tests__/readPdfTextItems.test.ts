// /app/__tests__/readPdfTextItems.test.ts
//
// readPdfTextItems() is the positioned-text reader for layouts the tab renderer
// cannot place -- a style name wrapped onto a second line under its column. It
// is only useful if the positions are real, so this builds a real two-page PDF
// in memory with text at known coordinates and reads it back through pdf-parse.
// No binary fixture is committed; nothing here is vendor data.
//
// The PDF is written by hand -- exact coordinates, no generator library between
// the test and pdf.js. It arrives as a small Buffer (carved from Node's shared
// pool), the case the bundled pdf.js misread under Jest on Node 24 until
// pdfUtils.parsePdf handed it a plain Uint8Array.

import { extractPdfText, readPdfTextItems } from "@/lib/pricing/pdfUtils";
import { minimalPdf } from "./helpers/minimalPdf";

const twoPagePdf = () =>
  minimalPdf([
    [
      { x: 72, y: 700, s: "ITEM NUMBER:" },
      { x: 300, y: 700, s: "Alder/Birch/" },
      { x: 300, y: 686, s: "Cedar/Dogwood" }, // the wrapped second line of that column
    ],
    [{ x: 72, y: 720, s: "page two" }],
  ]);

describe("readPdfTextItems", () => {
  it("returns every run with its page and position", async () => {
    const items = await readPdfTextItems(twoPagePdf());
    const find = (s: string) => items.find((i) => i.s === s);

    expect(find("ITEM NUMBER:")?.page).toBe(1);
    expect(find("page two")?.page).toBe(2);

    // x is where the run was drawn; the label and its column are apart.
    expect(find("ITEM NUMBER:")!.x).toBeCloseTo(72, 0);
    expect(find("Alder/Birch/")!.x).toBeCloseTo(300, 0);
    expect(find("ITEM NUMBER:")!.y).toBeCloseTo(700, 0);
    expect(find("ITEM NUMBER:")!.w).toBeGreaterThan(0);
  });

  it("the tab renderer reads the same file", async () => {
    const text = await extractPdfText(twoPagePdf());
    expect(text).toContain("ITEM NUMBER:\tAlder/Birch/");
    expect(text).toContain("page two");
  });

  // The whole point: a wrapped cell's second line shares its column's x, and
  // sits BELOW the first line -- PDF y grows upward, so its y is smaller.
  it("keeps a wrapped line under its column, one line lower", async () => {
    const items = await readPdfTextItems(twoPagePdf());
    const first = items.find((i) => i.s === "Alder/Birch/")!;
    const second = items.find((i) => i.s === "Cedar/Dogwood")!;
    expect(second.x).toBeCloseTo(first.x, 0);
    expect(first.y - second.y).toBeCloseTo(14, 0);
  });
});
