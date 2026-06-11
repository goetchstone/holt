// /app/__tests__/runProductsImportActiveFlag.test.ts
//
// A-grade pure-helper coverage for parseProductsImportActiveFlag — the
// 4-line parser that decides whether a row's `Active` column should flip
// `isActive`/`isDiscontinued` on the Product row. Easy to get wrong:
// missing the empty-string case would silently flip every product to
// inactive whenever the column is absent.
//
// The runner uses `undefined` as "leave the flag alone" — that matters
// for the manual UI upload path where older CSVs don't carry the
// column. Only an explicit yes/no should write a flag.

import { parseProductsImportActiveFlag } from "@/lib/adapters/ordorite/runners";

describe("parseProductsImportActiveFlag", () => {
  it("returns true for 'yes' (lowercase, the SH Item Export shape)", () => {
    expect(parseProductsImportActiveFlag("yes")).toBe(true);
  });

  it("returns true for 'YES' / 'Yes' (case-insensitive)", () => {
    expect(parseProductsImportActiveFlag("YES")).toBe(true);
    expect(parseProductsImportActiveFlag("Yes")).toBe(true);
  });

  it("returns true for 'y' / 'true' / '1' (tolerant variants)", () => {
    expect(parseProductsImportActiveFlag("y")).toBe(true);
    expect(parseProductsImportActiveFlag("true")).toBe(true);
    expect(parseProductsImportActiveFlag("1")).toBe(true);
  });

  it("returns false for 'no' / 'NO' / 'n' / 'false' / '0'", () => {
    expect(parseProductsImportActiveFlag("no")).toBe(false);
    expect(parseProductsImportActiveFlag("NO")).toBe(false);
    expect(parseProductsImportActiveFlag("n")).toBe(false);
    expect(parseProductsImportActiveFlag("false")).toBe(false);
    expect(parseProductsImportActiveFlag("0")).toBe(false);
  });

  it("returns undefined for the empty string (column absent / blank)", () => {
    expect(parseProductsImportActiveFlag("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only (Ordorite occasionally exports padded cells)", () => {
    expect(parseProductsImportActiveFlag("   ")).toBeUndefined();
  });

  it("returns undefined for unrecognized strings — don't guess", () => {
    expect(parseProductsImportActiveFlag("maybe")).toBeUndefined();
    expect(parseProductsImportActiveFlag("active")).toBeUndefined();
    expect(parseProductsImportActiveFlag("on")).toBeUndefined();
  });
});
