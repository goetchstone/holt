// /app/__tests__/vendorNumbering.test.ts
//
// Vendor prefixes exist so two vendors can both ship a part numbered "1827".
// Prefixing makes it unique and keeps the vendor's own number readable inside.
//
// This replaced a hardcoded scheme that knew one vendor's prefixes. The failure
// it caused was SILENT: a second vendor's numbers matched nothing, so items
// never linked -- no error, just missing links found much later. So the tests
// that matter are the ones proving a SECOND vendor works, and that an
// unconfigured deployment gets a clean "no".

import {
  isVendorNumber,
  ruleForNumber,
  toBarcode,
  toVendorNumber,
  type VendorPrefixRule,
} from "@/lib/vendorNumbering";

const MARJAN: VendorPrefixRule = { vendorId: 1, prefix: "MAR-", barcodePrefix: "M" };
const KILIM: VendorPrefixRule = { vendorId: 2, prefix: "KIL-", barcodePrefix: "K" };
const PLAIN: VendorPrefixRule = { vendorId: 3, prefix: "ACME-" };
const RULES = [MARJAN, KILIM, PLAIN];

describe("a number resolves to the vendor that issued it", () => {
  it("matches the product-number form and the tag form", () => {
    expect(ruleForNumber("MAR-1827-124A", RULES)?.vendorId).toBe(1);
    expect(ruleForNumber("M1827-124A", RULES)?.vendorId).toBe(1);
  });

  it("works for a SECOND vendor — the case the hardcoded version failed", () => {
    expect(ruleForNumber("KIL-4410", RULES)?.vendorId).toBe(2);
    expect(ruleForNumber("K4410", RULES)?.vendorId).toBe(2);
    expect(isVendorNumber("KIL-4410", RULES)).toBe(true);
  });

  it("is case-insensitive, because paperwork is", () => {
    expect(ruleForNumber("mar-1827", RULES)?.vendorId).toBe(1);
  });

  it("prefers the LONGER prefix when two could match", () => {
    // "MA-" and "MAR-" can both be configured. Resolving "MAR-1827" to "MA-"
    // because that row sorted first would file the item under the wrong vendor.
    const ambiguous = [{ vendorId: 9, prefix: "MA-" }, MARJAN];
    expect(ruleForNumber("MAR-1827", ambiguous)?.vendorId).toBe(1);
  });
});

describe("an unconfigured deployment has the feature off", () => {
  it("says no to everything with no rules", () => {
    expect(isVendorNumber("MAR-1827", [])).toBe(false);
    expect(ruleForNumber("MAR-1827", [])).toBeNull();
    expect(toVendorNumber("MAR-1827", [])).toBeNull();
  });

  it("returns an unrecognised number unchanged rather than mangling it", () => {
    expect(toBarcode("SOMETHING-ELSE", RULES)).toBe("SOMETHING-ELSE");
    expect(toBarcode("MAR-1827", [])).toBe("MAR-1827");
  });
});

describe("the two forms reduce to the same vendor number", () => {
  it("strips either prefix to the vendor's own number", () => {
    // The point: a sold line carries the tag and a returned line carries the
    // product number, so comparing tag to tag misses every match.
    expect(toVendorNumber("MAR-9381-25", RULES)).toBe("9381-25");
    expect(toVendorNumber("M9381-25", RULES)).toBe("9381-25");
    expect(toVendorNumber("KIL-9381-25", RULES)).toBe("9381-25");
  });

  it("converts a product number to its tag form", () => {
    expect(toBarcode("MAR-1827-124A", RULES)).toBe("M1827-124A");
    expect(toBarcode("KIL-4410", RULES)).toBe("K4410");
  });

  it("leaves the tag alone when the vendor configures no short form", () => {
    expect(toBarcode("ACME-77", RULES)).toBe("ACME-77");
    expect(toVendorNumber("ACME-77", RULES)).toBe("77");
  });

  it("returns null for a prefix with nothing after it", () => {
    // "MAR-" on its own is not a number; treating it as one would match every
    // consignment item with an empty vendor number.
    expect(toVendorNumber("MAR-", RULES)).toBeNull();
  });
});

describe("the cases the hardcoded version proved, now driven by configuration", () => {
  // Ported verbatim from consignment.test.ts, which tested isMarjanRug,
  // toMarjanBarcode and toMarjanCustomerNumber. Same inputs, same expectations,
  // reached through a VendorNumberPrefix row instead of a literal -- which is
  // how this change shows it made the behaviour configurable, not different.
  const MAR: VendorPrefixRule[] = [{ vendorId: 1, prefix: "MAR-", barcodePrefix: "M" }];

  it("detects the POS form and the tag form", () => {
    expect(isVendorNumber("MAR-9381-25", MAR)).toBe(true);
    expect(isVendorNumber("MAR-1827-124A", MAR)).toBe(true);
    expect(isVendorNumber("M1812-91", MAR)).toBe(true);
    expect(isVendorNumber("M8364-49", MAR)).toBe(true);
    expect(isVendorNumber("mar-1234-25", MAR)).toBe(true);
  });

  it("rejects other vendors' numbers and non-numbers", () => {
    expect(isVendorNumber("CRL-6600-14L", MAR)).toBe(false);
    expect(isVendorNumber("HOOK-6950-90215", MAR)).toBe(false);
    expect(isVendorNumber("DELIVERY CHARGE", MAR)).toBe(false);
    expect(isVendorNumber(null, MAR)).toBe(false);
    expect(isVendorNumber(undefined, MAR)).toBe(false);
    expect(isVendorNumber("", MAR)).toBe(false);
  });

  it("converts the POS form to the tag form and leaves the tag alone", () => {
    expect(toBarcode("MAR-1827-124A", MAR)).toBe("M1827-124A");
    expect(toBarcode("MAR-9381-25", MAR)).toBe("M9381-25");
    expect(toBarcode("M1812-91", MAR)).toBe("M1812-91");
    expect(toBarcode("M8364-49", MAR)).toBe("M8364-49");
  });

  it("reduces both forms to the vendor's own number", () => {
    expect(toVendorNumber("MAR-9381-25", MAR)).toBe("9381-25");
    expect(toVendorNumber("MAR-1827-124A", MAR)).toBe("1827-124A");
    expect(toVendorNumber("M1812-91", MAR)).toBe("1812-91");
    expect(toVendorNumber("M8364-49", MAR)).toBe("8364-49");
    expect(toVendorNumber("CRL-6600-14L", MAR)).toBeNull();
    expect(toVendorNumber("HOOK-6950", MAR)).toBeNull();
    expect(toVendorNumber("", MAR)).toBeNull();
  });
});
