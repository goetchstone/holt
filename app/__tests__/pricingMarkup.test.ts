// /app/__tests__/pricingMarkup.test.ts
//
// Which markup prices a product (GAP-06, lib/pricing/markup.ts): vendor,
// category and store, in the order the store chose, with anything that isn't a
// multiplier above zero counted as unset.

import {
  markupProblem,
  markupSourceLabel,
  markupValue,
  resolveMarkup,
  sameMarkup,
  styleMarkup,
  suggestedRetailLabel,
} from "@/lib/pricing/markup";

describe("resolveMarkup", () => {
  it("takes the vendor's first by default, then the category's, then the store's", () => {
    expect(resolveMarkup({ vendorMarkup: 2.2, categoryMarkup: 3, storeMarkup: 2 })).toEqual({
      multiplier: 2.2,
      source: "vendor",
    });
    expect(resolveMarkup({ vendorMarkup: null, categoryMarkup: 3, storeMarkup: 2 })).toEqual({
      multiplier: 3,
      source: "category",
    });
    expect(resolveMarkup({ vendorMarkup: null, categoryMarkup: null, storeMarkup: 2 })).toEqual({
      multiplier: 2,
      source: "store",
    });
  });

  it("takes the category's first when the store says so, still falling back to the store's", () => {
    const precedence = "CATEGORY_FIRST" as const;
    expect(
      resolveMarkup({ vendorMarkup: 2.2, categoryMarkup: 3, storeMarkup: 2, precedence }),
    ).toEqual({ multiplier: 3, source: "category" });
    expect(
      resolveMarkup({ vendorMarkup: 2.2, categoryMarkup: null, storeMarkup: 2, precedence }),
    ).toEqual({ multiplier: 2.2, source: "vendor" });
    expect(resolveMarkup({ storeMarkup: 2, precedence })).toEqual({
      multiplier: 2,
      source: "store",
    });
  });

  it("counts zero, negative, NaN and junk as unset, and finds nothing when nothing is set", () => {
    expect(
      resolveMarkup({ vendorMarkup: 0, categoryMarkup: -2, storeMarkup: Number.NaN }),
    ).toBeNull();
    expect(
      resolveMarkup({ vendorMarkup: "abc", categoryMarkup: true, storeMarkup: {} }),
    ).toBeNull();
    expect(resolveMarkup({})).toBeNull();
    expect(resolveMarkup({ vendorMarkup: 0, storeMarkup: 2.5 })).toEqual({
      multiplier: 2.5,
      source: "store",
    });
  });

  it("reads a Decimal's text, as Prisma hands it over", () => {
    expect(resolveMarkup({ vendorMarkup: "2.4000" })).toEqual({
      multiplier: 2.4,
      source: "vendor",
    });
  });
});

describe("markupValue / markupProblem / sameMarkup", () => {
  it("reads a markup or nothing", () => {
    expect(markupValue("")).toBeNull();
    expect(markupValue(undefined)).toBeNull();
    expect(markupValue(Infinity)).toBeNull();
    expect(markupValue(1.5)).toBe(1.5);
  });

  it("lets a store save a multiplier above zero, or clear it", () => {
    expect(markupProblem(null)).toBeNull();
    expect(markupProblem(2.2)).toBeNull();
    expect(markupProblem(0)).toMatch(/above zero/);
    expect(markupProblem(-1)).toMatch(/above zero/);
    expect(markupProblem("2.2")).toMatch(/above zero/);
    expect(markupProblem(10000)).toMatch(/under 10,000/);
  });

  it("compares to four places, and unset only to unset", () => {
    expect(sameMarkup("2.2000", 2.2)).toBe(true);
    expect(sameMarkup(2.2, 2.20001)).toBe(true);
    expect(sameMarkup(2.2, 2.3)).toBe(false);
    expect(sameMarkup(null, 0)).toBe(true);
    expect(sameMarkup(null, 2)).toBe(false);
  });
});

describe("styleMarkup (the configurators)", () => {
  it("prices a style from its own markup, even when that is none", () => {
    expect(styleMarkup({ markup: 3, markupSource: "category" }, 2)).toBe(3);
    // Resolved to nothing for this style: no retail is invented from the vendor's.
    expect(styleMarkup({ markup: null, markupSource: null }, 2)).toBeNull();
  });

  it("falls back to the vendor-level markup with no style chosen or none sent", () => {
    expect(styleMarkup(null, 2)).toBe(2);
    expect(styleMarkup({}, 2)).toBe(2);
  });

  it("names where a suggestion's markup came from", () => {
    expect(markupSourceLabel({ markup: 3, markupSource: "category" })).toBe("category's");
    expect(markupSourceLabel({ markup: 2, markupSource: "store" })).toBe("store's");
    expect(markupSourceLabel(null)).toBe("");
  });

  it("labels the suggestion with the markup and its source", () => {
    expect(suggestedRetailLabel(3, { markup: 3, markupSource: "category" })).toBe(
      "Suggested Retail (3x, category's)",
    );
    expect(suggestedRetailLabel(null, null)).toBe("Suggested Retail (\u2014x)");
  });
});
