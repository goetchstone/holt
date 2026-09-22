// /app/__tests__/importVendorConfigs.test.ts
//
// USE-03: the price-book import dropdown is DERIVED from the wholesale registry,
// so a vendor this build can already read cannot be missing from the menu.
// hooker, sam-moore and bradington-young parsed fine yet were absent from the
// old hardcoded VENDOR_CONFIGS array; these pin that drift shut for good.

import { VENDOR_CONFIGS } from "@/lib/pricing/importVendorConfigs";
import { supportedWholesaleVendorIds } from "@/lib/pricing/wholesale/registry";

describe("import vendor configs", () => {
  it("has no duplicate slugs", () => {
    const slugs = VENDOR_CONFIGS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("lists every wholesale vendor the build can read", () => {
    const configured = new Set(VENDOR_CONFIGS.map((c) => c.slug));
    for (const id of supportedWholesaleVendorIds()) {
      expect(configured.has(id)).toBe(true);
    }
  });

  it("surfaces the three registry vendors the hardcoded list omitted", () => {
    const slugs = VENDOR_CONFIGS.map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(["hooker", "sam-moore", "bradington-young"]));
  });

  it("offers at least the twelve vendors the pricing hub advertises", () => {
    expect(VENDOR_CONFIGS.length).toBeGreaterThanOrEqual(12);
  });

  it("gives Hooker a nameMatch that matches a store's vendor row, not the book title", () => {
    const hooker = VENDOR_CONFIGS.find((c) => c.slug === "hooker");
    // "Hooker Custom Upholstery".toLowerCase() is not a substring of a vendor
    // row reading "Hooker Furniture" -- the profile's nameMatch is what matches.
    expect(hooker?.nameMatch).toBe("hooker");
    expect(hooker?.displayName).toBe("Hooker Custom Upholstery");
  });
});
