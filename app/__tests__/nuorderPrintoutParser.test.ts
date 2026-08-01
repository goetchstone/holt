// /app/__tests__/nuorderPrintoutParser.test.ts
//
// Pins the pure core of the NuOrder "order printout" parser
// (parseNuOrderPrintoutItems) with hand-computed positioned-item fixtures.
// Geometry mirrors the real PDFs (Frank & Eileen PO 18573341, Hunter Bell
// PO 18908185): size-header labels at their real x positions, quantity
// digits offset a few points from the label x, color text far left of the
// grid. The bug shapes covered are the ones that made pdf-parse text
// unusable for this layout: ambiguous digit runs (column binning), wrapped
// color rows, numeric color codes, and the refuse-to-guess drops.

import {
  parseNuOrderPrintoutItems,
  type PositionedItem,
} from "@/lib/pricing/nuorderPrintoutParser";

function pi(str: string, x: number, y: number): PositionedItem {
  return { str, x, y };
}

/** Order Information block + PO row as they appear at the top of every page. */
function pageHeader(): PositionedItem[] {
  return [
    pi("PO#:", 476, 791),
    pi("18573341", 500, 791),
    pi("Created:", 55, 764),
    pi("10/07/2025", 84, 764),
    pi("Contact: Erica", 176, 764),
    pi("Start Ship:", 55, 757),
    pi("06/01/2026", 90, 757),
    pi("Complete Ship:", 55, 750),
    pi("06/15/2026", 105, 750),
    pi("Terms:", 55, 743),
    pi("PRE-PAID CREDIT CARD", 79, 743),
    pi("Los Angeles , CA 90014 United States", 176, 743),
  ];
}

function styleAnchor(style: string, wholesale: string, retail: string, y: number) {
  return [
    pi("Style #", 57, y),
    pi(style, 80, y),
    pi("|", 104, y),
    pi("JUNE '26", 108, y),
    pi("Wholesale:", 373, y),
    pi(`USD ${wholesale}`, 409, y),
    pi("Sugg. Retail:", 458, y),
    pi(`USD ${retail}`, 501, y),
  ];
}

function letterSizeHeader(y: number): PositionedItem[] {
  return [
    pi("Colors", 147, y + 4),
    pi("Total", 502, y + 4),
    pi("XXS", 310, y),
    pi("XS", 331, y),
    pi("S", 351, y),
    pi("M", 368, y),
    pi("L", 387, y),
    pi("XL", 403, y),
    pi("Qty", 421, y),
  ];
}

/** The EILEEN/PRBG block from page 1 of the real F&E printout, including the
 *  color description wrapping BELOW the quantity row ("Flowers"). */
function eileenBlock(): PositionedItem[] {
  return [
    pi("Relaxed Button-Up Shirt", 57, 687),
    ...styleAnchor("EILEEN", "112.00", "258.00", 675),
    ...letterSizeHeader(654),
    pi("PRBG", 183, 639),
    pi("Pink Red Blue", 202, 639),
    pi("1", 333, 636),
    pi("1", 351, 636),
    pi("1", 369, 636),
    pi("1", 387, 636),
    pi("4", 425, 636),
    pi("USD 448.00", 480, 636),
    pi("Flowers", 183, 632),
  ];
}

function orderSummary(qty: string, total: string): PositionedItem[] {
  return [
    pi("Order Comments:", 57, 535),
    pi("Total Quantity:", 346, 533),
    pi(qty, 519, 533),
    pi("Subtotal:", 346, 523),
    pi(`USD ${total}`, 461, 523),
    pi("Grand Total:", 346, 513),
    pi(`USD ${total}`, 461, 513),
  ];
}

describe("parseNuOrderPrintoutItems — happy paths", () => {
  it("bins letter-grid digits to size columns by nearest header x", () => {
    const parsed = parseNuOrderPrintoutItems([
      [...pageHeader(), ...eileenBlock(), ...orderSummary("4", "448.00")],
    ]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    const item = parsed.items[0];
    expect(item.styleNumber).toBe("EILEEN");
    expect(item.productName).toBe("Relaxed Button-Up Shirt");
    expect(item.unitPrice).toBe(112);
    expect(item.msrp).toBe(258);
    expect(item.totalUnits).toBe(4);
    expect(item.totalPrice).toBe(448);
    // Digits sit under XS/S/M/L — XXS and XL stay empty.
    expect(item.sizes).toEqual([
      { size: "XS", quantity: 1 },
      { size: "S", quantity: 1 },
      { size: "M", quantity: 1 },
      { size: "L", quantity: 1 },
    ]);
  });

  it("accumulates wrapped color rows, including the wrap below the quantity row", () => {
    const parsed = parseNuOrderPrintoutItems([
      [...pageHeader(), ...eileenBlock(), ...orderSummary("4", "448.00")],
    ]);
    expect(parsed.items[0].colorCode).toBe("PRBG Pink Red Blue Flowers");
  });

  it("reads the order header, season, and printed totals", () => {
    const parsed = parseNuOrderPrintoutItems([
      [...pageHeader(), ...eileenBlock(), ...orderSummary("4", "448.00")],
    ]);
    expect(parsed.poNumber).toBe("18573341");
    expect(parsed.orderDate).toBe("10/07/2025");
    expect(parsed.deliveryStart).toBe("06/01/2026");
    expect(parsed.deliveryEnd).toBe("06/15/2026");
    expect(parsed.terms).toBe("PRE-PAID CREDIT CARD");
    expect(parsed.season).toBe("JUNE '26");
    expect(parsed.totalUnits).toBe(4);
    expect(parsed.totalPrice).toBe(448);
    // The printout renders the brand as a logo image — never text.
    expect(parsed.vendorName).toBe("");
  });

  it("classifies a numeric color code ('1984') by x-position, not digit-ness, and reads a stacked USD/amount total on a numeric grid", () => {
    const page = [
      ...pageHeader(),
      pi('Waterford 7.5"', 57, 700),
      ...styleAnchor("GOLFSHORT", "121.00", "278.00", 690),
      pi("Colors", 147, 675),
      pi("Total", 504, 675),
      pi("00", 291, 671),
      pi("0", 309, 671),
      pi("2", 324, 671),
      pi("4", 339, 671),
      pi("6", 354, 671),
      pi("8", 370, 671),
      pi("10", 384, 671),
      pi("12", 401, 671),
      pi("14", 418, 671),
      pi("Qty", 434, 671),
      // NuOrder stacks the line total as "USD" above and the amount below.
      pi("USD", 506, 660),
      pi("1984", 182, 657),
      pi("Washed Blue", 199, 657),
      pi("1", 324, 657),
      pi("1", 339, 657),
      pi("1", 354, 657),
      pi("1", 370, 657),
      pi("1", 386, 657),
      pi("5", 438, 657),
      pi("605.00", 497, 653),
      ...orderSummary("5", "605.00"),
    ];
    const parsed = parseNuOrderPrintoutItems([page]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    const item = parsed.items[0];
    expect(item.colorCode).toBe("1984 Washed Blue");
    expect(item.totalPrice).toBe(605);
    expect(item.sizes).toEqual([
      { size: "2", quantity: 1 },
      { size: "4", quantity: 1 },
      { size: "6", quantity: 1 },
      { size: "8", quantity: 1 },
      { size: "10", quantity: 1 },
    ]);
  });

  it("collapses the doubled one-size color text ('Natural Natural')", () => {
    const page = [
      ...pageHeader(),
      pi("Small HB Canvas Tote", 57, 700),
      ...styleAnchor("26HSA4Nat", "42.00", "100.00", 690),
      pi("Colors", 147, 675),
      pi("Total", 473, 675),
      pi("OS", 352, 671),
      pi("Qty", 372, 671),
      pi("Natural Natural", 183, 650),
      pi("1", 355, 650),
      pi("1", 376, 650),
      pi("USD 42.00", 451, 650),
      ...orderSummary("1", "42.00"),
    ];
    const parsed = parseNuOrderPrintoutItems([page]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items[0].colorCode).toBe("Natural");
    expect(parsed.items[0].sizes).toEqual([{ size: "OS", quantity: 1 }]);
  });
});

describe("parseNuOrderPrintoutItems — refuse-to-guess", () => {
  it("drops a block whose size quantities do not sum to its Qty column", () => {
    const page = [
      ...pageHeader(),
      pi("Relaxed Button-Up Shirt", 57, 687),
      ...styleAnchor("EILEEN", "112.00", "258.00", 675),
      ...letterSizeHeader(654),
      pi("PRBG", 183, 639),
      pi("Pink Red Blue", 202, 639),
      // Only 3 size digits against a Qty of 4 — never guessed.
      pi("1", 333, 636),
      pi("1", 351, 636),
      pi("1", 369, 636),
      pi("4", 425, 636),
      pi("USD 448.00", 480, 636),
      ...orderSummary("4", "448.00"),
    ];
    const parsed = parseNuOrderPrintoutItems([page]);
    expect(parsed.items).toHaveLength(0);
    expect(parsed.warnings.some((w) => /EILEEN/.test(w) && /sum to 3/.test(w))).toBe(true);
    // The dropped line also surfaces as a grand-total mismatch.
    expect(parsed.warnings.some((w) => /Grand Total/.test(w))).toBe(true);
  });

  it("drops a block whose unit price x quantity does not match the printed line total", () => {
    const page = [
      ...pageHeader(),
      pi("Relaxed Button-Up Shirt", 57, 687),
      ...styleAnchor("EILEEN", "112.00", "258.00", 675),
      ...letterSizeHeader(654),
      pi("PRBG", 183, 639),
      pi("1", 333, 636),
      pi("1", 351, 636),
      pi("1", 369, 636),
      pi("1", 387, 636),
      pi("4", 425, 636),
      pi("USD 500.00", 480, 636),
      ...orderSummary("4", "500.00"),
    ];
    const parsed = parseNuOrderPrintoutItems([page]);
    expect(parsed.items).toHaveLength(0);
    expect(parsed.warnings.some((w) => /does not equal the printed line total/.test(w))).toBe(true);
  });

  it("warns when the parsed items do not add up to the printed Grand Total", () => {
    const parsed = parseNuOrderPrintoutItems([
      [...pageHeader(), ...eileenBlock(), ...orderSummary("4", "500.00")],
    ]);
    // The block itself is internally consistent, so it is kept — the
    // mismatch against the document total is surfaced, not hidden.
    expect(parsed.items).toHaveLength(1);
    expect(parsed.warnings.some((w) => /448\.00.*500\.00/.test(w))).toBe(true);
  });
});

describe("parseNuOrderPrintoutItems — cancelled styles", () => {
  it("excludes the Cancelled Styles section from items but summarizes it", () => {
    const page = [
      ...pageHeader(),
      ...eileenBlock(),
      // Active summary renders above the cancelled section on the last page.
      pi("Total Quantity:", 346, 605),
      pi("4", 519, 605),
      pi("Grand Total:", 346, 600),
      pi("USD 448.00", 461, 600),
      pi("Cancelled Styles:", 57, 560),
      pi("One-Size Button-Up Dress", 57, 550),
      ...styleAnchor("MEGAN", "143.00", "328.00", 540),
      pi("Colors", 147, 522),
      pi("Total", 473, 522),
      pi("O/S", 352, 518),
      pi("Qty", 372, 518),
      pi("V000 White", 185, 500),
      pi("2", 355, 500),
      pi("2", 376, 500),
      pi("USD 286.00", 451, 500),
      // The summary box repeats the heading at x~346 — must not re-flip.
      pi("Cancelled Styles:", 346, 433),
      pi("Total Quantity:", 346, 426),
      pi("2", 534, 426),
      pi("Total:", 346, 419),
      pi("USD 286.00", 497, 419),
    ];
    const parsed = parseNuOrderPrintoutItems([page]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].styleNumber).toBe("EILEEN");
    expect(parsed.cancelled).toEqual({ items: 1, units: 2, total: 286 });
    // The cancelled section's own Total Quantity must not clobber the order's.
    expect(parsed.totalUnits).toBe(4);
    expect(parsed.totalPrice).toBe(448);
  });
});
