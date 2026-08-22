// /app/__tests__/consignment.test.ts

import {
  calculateRugPricing,
  mapConsignmentStatusRow,
  isValidConsignmentTransition,
  getValidConsignmentTransitions,
  findWashedRugCustomerNumbers,
} from "../src/lib/consignment";
import type { VendorPrefixRule } from "../src/lib/vendorNumbering";

/**
 * The scheme that used to be hardcoded inside lib/consignment.ts, supplied as
 * configuration now. Same prefixes, same expectations below -- which is the
 * point: this made the behaviour configurable, not different.
 */
const PREFIX_RULES: VendorPrefixRule[] = [{ vendorId: 1, prefix: "MAR-", barcodePrefix: "M" }];

describe("calculateRugPricing", () => {
  it("calculates anchor as cost * 7 and retail as anchor / 2", () => {
    const result = calculateRugPricing(100);
    expect(result.anchorPrice).toBe(700);
    expect(result.retailPrice).toBe(350);
  });

  it("handles fractional costs with rounding", () => {
    const result = calculateRugPricing(108.333333);
    expect(result.anchorPrice).toBe(758.33);
    expect(result.retailPrice).toBe(379.17);
  });

  it("handles zero cost", () => {
    const result = calculateRugPricing(0);
    expect(result.anchorPrice).toBe(0);
    expect(result.retailPrice).toBe(0);
  });

  it("matches vendor data example", () => {
    // From sample-data-6.xls: cost 1987.152778
    const result = calculateRugPricing(1987.152778);
    expect(result.anchorPrice).toBe(13910.07);
    expect(result.retailPrice).toBe(6955.04);
  });
});

describe("mapConsignmentStatusRow", () => {
  it("returns ON_FLOOR for default row", () => {
    expect(mapConsignmentStatusRow({ is_sold: 0, is_returned: 0, is_paid: 0, is_Missing: 0 })).toBe(
      "ON_FLOOR",
    );
  });

  it("returns PAID when is_paid is 1", () => {
    expect(mapConsignmentStatusRow({ is_sold: 1, is_returned: 0, is_paid: 1, is_Missing: 0 })).toBe(
      "PAID",
    );
  });

  it("returns SOLD when is_sold is 1", () => {
    expect(mapConsignmentStatusRow({ is_sold: 1, is_returned: 0, is_paid: 0, is_Missing: 0 })).toBe(
      "SOLD",
    );
  });

  it("returns RETURNED_VENDOR when is_returned is 1", () => {
    expect(mapConsignmentStatusRow({ is_sold: 0, is_returned: 1, is_paid: 0, is_Missing: 0 })).toBe(
      "RETURNED_VENDOR",
    );
  });

  it("returns MISSING when is_Missing is 1", () => {
    expect(mapConsignmentStatusRow({ is_sold: 0, is_returned: 0, is_paid: 0, is_Missing: 1 })).toBe(
      "MISSING",
    );
  });

  it("PAID takes priority over SOLD", () => {
    expect(mapConsignmentStatusRow({ is_sold: 1, is_paid: 1, is_returned: 0, is_Missing: 0 })).toBe(
      "PAID",
    );
  });

  it("handles string number values from CSV", () => {
    expect(
      mapConsignmentStatusRow({ is_sold: "0", is_returned: "1", is_paid: "0", is_Missing: "0" }),
    ).toBe("RETURNED_VENDOR");
  });

  it("handles missing fields gracefully", () => {
    expect(mapConsignmentStatusRow({})).toBe("ON_FLOOR");
  });
});

describe("isValidConsignmentTransition", () => {
  it("allows ON_FLOOR to ON_APPROVAL", () => {
    expect(isValidConsignmentTransition("ON_FLOOR", "ON_APPROVAL")).toBe(true);
  });

  it("allows ON_FLOOR to SOLD", () => {
    expect(isValidConsignmentTransition("ON_FLOOR", "SOLD")).toBe(true);
  });

  it("allows ON_FLOOR to RETURNED_VENDOR", () => {
    expect(isValidConsignmentTransition("ON_FLOOR", "RETURNED_VENDOR")).toBe(true);
  });

  it("allows ON_FLOOR to MISSING", () => {
    expect(isValidConsignmentTransition("ON_FLOOR", "MISSING")).toBe(true);
  });

  it("allows ON_APPROVAL to ON_FLOOR", () => {
    expect(isValidConsignmentTransition("ON_APPROVAL", "ON_FLOOR")).toBe(true);
  });

  it("allows ON_APPROVAL to SOLD", () => {
    expect(isValidConsignmentTransition("ON_APPROVAL", "SOLD")).toBe(true);
  });

  it("allows SOLD to PAID", () => {
    expect(isValidConsignmentTransition("SOLD", "PAID")).toBe(true);
  });

  it("allows MISSING to ON_FLOOR (found)", () => {
    expect(isValidConsignmentTransition("MISSING", "ON_FLOOR")).toBe(true);
  });

  it("allows PAID to ON_FLOOR (customer return after vendor payment)", () => {
    expect(isValidConsignmentTransition("PAID", "ON_FLOOR")).toBe(true);
    expect(isValidConsignmentTransition("PAID", "SOLD")).toBe(false);
  });

  it("blocks RETURNED_VENDOR to anything", () => {
    expect(isValidConsignmentTransition("RETURNED_VENDOR", "ON_FLOOR")).toBe(false);
  });

  it("blocks ON_APPROVAL to RETURNED_VENDOR directly", () => {
    expect(isValidConsignmentTransition("ON_APPROVAL", "RETURNED_VENDOR")).toBe(false);
  });
});

describe("getValidConsignmentTransitions", () => {
  it("returns all valid targets for ON_FLOOR", () => {
    const transitions = getValidConsignmentTransitions("ON_FLOOR");
    expect(transitions).toContain("ON_APPROVAL");
    expect(transitions).toContain("SOLD");
    expect(transitions).toContain("RETURNED_VENDOR");
    expect(transitions).toContain("MISSING");
    expect(transitions).toHaveLength(4);
  });

  it("returns ON_FLOOR for PAID (vendor credit path)", () => {
    expect(getValidConsignmentTransitions("PAID")).toEqual(["ON_FLOOR"]);
  });

  it("returns empty array for terminal states", () => {
    expect(getValidConsignmentTransitions("RETURNED_VENDOR")).toHaveLength(0);
  });
});

describe("findWashedRugCustomerNumbers", () => {
  it("matches a same-day sell+return across the barcode/product-number gap (SBOM42090)", () => {
    // The sold side has the PHYSICAL barcode "M8994-22"; the returned side has
    // toMarjanBarcode("MAR-10684-26") = "M10684-26". These never equal — the
    // shared key is the customerNumber "10684-26". The old barcode comparison
    // missed this, leaving the rug SOLD (wrongly owed to Marjan).
    const sold = [
      { barcode: "M8994-22", customerNumber: "10684-26" },
      { barcode: "M8996-71", customerNumber: "10685-26" },
    ];
    const returned = ["M10684-26", "M10685-26"]; // toMarjanBarcode(MAR-…) form
    const washed = findWashedRugCustomerNumbers(sold, returned, PREFIX_RULES);
    expect(washed).toEqual(new Set(["10684-26", "10685-26"]));
  });

  it("does NOT wash a rug that only sold (no matching return)", () => {
    const sold = [{ barcode: "M8994-22", customerNumber: "10684-26" }];
    expect(findWashedRugCustomerNumbers(sold, [], PREFIX_RULES).size).toBe(0);
    // A different rug returned — no overlap.
    expect(findWashedRugCustomerNumbers(sold, ["M9999-99"], PREFIX_RULES).size).toBe(0);
  });

  it("ignores non-Marjan and null identifiers", () => {
    const sold = [{ barcode: null, customerNumber: null }];
    expect(
      findWashedRugCustomerNumbers(sold, ["CRL-6600", null, undefined], PREFIX_RULES).size,
    ).toBe(0);
  });

  it("does NOT wash a rug re-sold more times than returned (net SOLD)", () => {
    // M1854-236: sold on GTOM3819, returned on GTOA10324, then RE-SOLD on
    // GTOM3820 — two sale lines against one return in the batch. Net +1, so the
    // rug is legitimately SOLD and must NOT wash (reverting it would erase the
    // second sale and understate what's owed to Marjan).
    const sold = [
      { barcode: null, customerNumber: "9932-26" },
      { barcode: null, customerNumber: "9932-26" },
    ];
    const returned = ["M9932-26"];
    expect(findWashedRugCustomerNumbers(sold, returned, PREFIX_RULES).size).toBe(0);
  });

  it("washes only when returns fully offset sales (net <= 0)", () => {
    // Two rugs in one batch: A sold twice / returned twice (net 0 -> wash);
    // B sold twice / returned once (net +1 -> keep SOLD).
    const sold = [
      { barcode: null, customerNumber: "10685-26" },
      { barcode: null, customerNumber: "10685-26" },
      { barcode: null, customerNumber: "10561-26" },
      { barcode: null, customerNumber: "10561-26" },
    ];
    const returned = ["M10685-26", "M10685-26", "M10561-26"];
    expect(findWashedRugCustomerNumbers(sold, returned, PREFIX_RULES)).toEqual(
      new Set(["10685-26"]),
    );
  });
});
