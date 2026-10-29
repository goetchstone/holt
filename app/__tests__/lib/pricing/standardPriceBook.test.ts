// /app/__tests__/lib/pricing/standardPriceBook.test.ts
//
// The standard price-book layout (lib/pricing/standardPriceBook.ts): every
// column says what it is, and anything it can't read is reported, never
// dropped. The demo's committed books must parse clean, because the demo
// seed refuses a book with any diagnostic.

import { readFileSync } from "fs";
import { join } from "path";
import {
  parseStandardPriceBookCsv,
  parseStandardPriceBookRows,
  standardTemplateCsv,
} from "@/lib/pricing/standardPriceBook";
import { wholesaleImportSchema } from "@/lib/validation/schemas";

const BOOKS = join(__dirname, "../../../prisma/seed/demo/pricebooks");

describe("the demo's standard-layout books", () => {
  it.each([
    ["vellmora-recliner-co.csv", 12, "LEATHER"],
    ["larkmoor-leatherworks.csv", 16, "LEATHER"],
    ["pellwood-custom-upholstery.csv", 18, "FABRIC"],
  ])("%s parses with no diagnostics and validates as an import", (file, styles, material) => {
    const parsed = parseStandardPriceBookCsv(readFileSync(join(BOOKS, file), "utf8"));
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.data).toHaveLength(styles);
    expect(parsed.data.every((p) => p.gradePrices.every((g) => g.material === material))).toBe(
      true,
    );
    expect(() =>
      wholesaleImportSchema.parse({ vendorId: 1, priceListName: "W", products: parsed.data }),
    ).not.toThrow();
  });
});

describe("parseStandardPriceBookRows", () => {
  const row = (over: Record<string, string>) => ({
    "Style #": "100-S",
    "Style Name": "Test Sofa",
    Description: "Sofa",
    COM: "980",
    "Fabric 14": "$1,040.00",
    "Leather D": "",
    "COM Yardage": "14",
    "Grade Riser": "40",
    "Option: Nailhead / Antique Brass": "Std",
    "Option: Skirt / Kick Pleat": "N/A",
    "Option: Finish / Premium": "N/C",
    "Option: Base / Swivel": "185",
    "Option: Base / Glider": "",
    ...over,
  });

  it("reads declared grades, measures and every option cell", () => {
    const [product] = parseStandardPriceBookRows([row({})]).data;
    expect(product.gradePrices).toEqual([
      { grade: "COM", cost: 980, material: "FABRIC" },
      { grade: "14", cost: 1040, material: "FABRIC" },
    ]);
    expect(product).toMatchObject({ yardagePlain: 14, gradeRiser: 40 });
    expect(
      product.styleOptions?.map((o) => [
        o.groupName,
        o.optionName,
        o.surcharge,
        o.isStandard,
        o.isAvailable,
      ]),
    ).toEqual([
      ["Nailhead", "Antique Brass", 0, true, true],
      ["Skirt", "Kick Pleat", 0, false, false],
      ["Finish", "Premium", 0, false, true],
      ["Base", "Swivel", 185, false, true],
    ]);
  });

  it("reports a column outside the layout instead of dropping it silently", () => {
    const parsed = parseStandardPriceBookRows([row({ "Grade 7": "900" })]);
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        message: 'Column "Grade 7" isn\'t part of the standard layout, so it was ignored.',
      }),
    ]);
  });

  it("refuses a grade declared as both fabric and leather", () => {
    const parsed = parseStandardPriceBookRows([row({ "Leather 14": "1900" })]);
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ level: "error", message: expect.stringContaining('Grade "14"') }),
    ]);
    expect(parsed.data[0].gradePrices.map((g) => g.grade)).toEqual(["COM", "14"]);
  });

  it("warns on an unreadable cost or option and keeps the rest of the row", () => {
    const parsed = parseStandardPriceBookRows([
      row({ "Fabric 14": "call", "Option: Base / Swivel": "maybe" }),
    ]);
    expect(parsed.data[0].gradePrices.map((g) => g.grade)).toEqual(["COM"]);
    expect(parsed.diagnostics.map((d) => [d.row, d.field])).toEqual([
      [2, "Fabric 14"],
      [2, "Option: Base / Swivel"],
    ]);
  });

  it("skips a row with no style number or no cost, saying why", () => {
    const parsed = parseStandardPriceBookRows([
      row({ "Style #": "" }),
      row({ "Style #": "200-S", COM: "", "Fabric 14": "" }),
    ]);
    expect(parsed.data).toEqual([]);
    expect(parsed.summary.skippedCount).toBe(2);
    expect(parsed.diagnostics.map((d) => d.message)).toEqual([
      "No style number, so the row was skipped.",
      "Style 200-S has no grade cost, so it was skipped.",
    ]);
  });

  it("is not a standard book without a Style # column", () => {
    const parsed = parseStandardPriceBookRows([{ SKU: "1", Cost: "2" }]);
    expect(parsed.data).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining('No "Style #" column'),
      }),
    );
  });
});

describe("standardTemplateCsv", () => {
  it("round-trips through the parser with no diagnostics", () => {
    const parsed = parseStandardPriceBookCsv(standardTemplateCsv());
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.data.map((p) => p.styleNumber)).toEqual(["1001-S", "1001-C"]);
  });
});
