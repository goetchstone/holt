// /app/__tests__/readPdfTextItems.test.ts
//
// readPdfTextItems() is the positioned-text reader for layouts the tab renderer
// cannot place -- a style name wrapped onto a second line under its column. It
// is only useful if the positions are real, so this builds a real two-page PDF
// in memory (jsPDF, in points) with text at known coordinates and reads it back
// through pdf-parse. No binary fixture is committed; nothing here is vendor data.

import { jsPDF } from "jspdf";
import { readPdfTextItems } from "@/lib/pricing/pdfUtils";

async function twoPagePdf(): Promise<Buffer> {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  doc.text("ITEM NUMBER:", 72, 100);
  doc.text("Raymond/Reece/", 300, 100);
  doc.text("Revelin/Raiden", 300, 114); // the wrapped second line of that column
  doc.addPage();
  doc.text("page two", 72, 72);
  return Buffer.from(doc.output("arraybuffer"));
}

describe("readPdfTextItems", () => {
  it("returns every run with its page and position", async () => {
    const items = await readPdfTextItems(await twoPagePdf());
    const find = (s: string) => items.find((i) => i.s === s);

    expect(find("ITEM NUMBER:")?.page).toBe(1);
    expect(find("page two")?.page).toBe(2);

    // x is where the run was drawn; the label and its column are apart.
    expect(find("ITEM NUMBER:")!.x).toBeCloseTo(72, 0);
    expect(find("Raymond/Reece/")!.x).toBeCloseTo(300, 0);
    expect(find("ITEM NUMBER:")!.w).toBeGreaterThan(0);
  });

  // The whole point: a wrapped cell's second line shares its column's x, and
  // sits BELOW the first line -- PDF y grows upward, so its y is smaller.
  it("keeps a wrapped line under its column, one line lower", async () => {
    const items = await readPdfTextItems(await twoPagePdf());
    const first = items.find((i) => i.s === "Raymond/Reece/")!;
    const second = items.find((i) => i.s === "Revelin/Raiden")!;
    expect(second.x).toBeCloseTo(first.x, 0);
    expect(first.y - second.y).toBeCloseTo(14, 0);
  });
});
