// /app/__tests__/wendoverOrderParser.test.ts
//
// Pure tests for the Wendover Art Group order parser. The fixture is a
// condensed copy of the real order confirmation (#1000292821, 2026-07-13,
// 18 items, $10,976.49) and deliberately keeps the two shapes that a naive
// parser gets wrong:
//
//   * the page-break block where an item's qty+price prints BEFORE its own
//     "SKU:" line, trailing the item's name;
//   * the non-breaking space in "Your Order #..." that the real Gmail
//     print-to-PDF emits.

import { parseWendoverOrderText, WENDOVER_VENDOR_NAME } from "@/lib/pricing/wendoverOrderParser";

const NBSP = " ";

// Verbatim shapes from the real extraction, condensed to four items.
const FIXTURE = [
  "Your Order" + NBSP + "#1000292821",
  "Placed on Jul 13, 2026, 12:26:21 PM",
  "ItemsQtyPrice",
  "Before the Rain  Customized",
  "SKU: WLD3511",
  "Medium",
  "Canvas",
  "Treatment",
  "Gallery Wrapped, Artist Enhanced",
  "Size",
  '35.01"w x 41.01"h',
  "Frame",
  'M1123, Antique Silver, 0.38"w x 2.13"d',
  "3$1,057.62",
  "Patterned Dignity 1 ",
  "SKU: WAN2552",
  "Medium",
  "Matte Paper",
  "Treatment",
  "Non-Customizable",
  "3$745.20",
  // Page break: the NEXT item's name and price print together, ahead of
  // its SKU line, with the print's page furniture in between.
  "Patterned Dignity 4 3$745.20",
  "7/16/26, 1:11 PMsaybrookhome.com Mail - Fwd: Your Wendover Art Group order confirmation",
  "Page 3 of 8https://mail.google.com/mail/u/1/?ik=77234f1af6",
  "SKU: WAN2555",
  "Medium",
  "Matte Paper",
  // No price follows this SKU: WAN2555's price already printed above, on
  // its name line. The next price in the real document belongs to the
  // FOLLOWING item.
  "Delicate Blooms 6 ",
  "SKU: WFL1944",
  "Medium",
  "Matte Paper",
  "Bottom Mat",
  'B97, Polar White, 3"',
  "Side Mark",
  "SBOM41649/Erin Kelly",
  "1$205.20",
  "Subtotal $2,753.22",
  "Shipping $743.59",
  "Grand Total$3,496.81",
].join("\n");

describe("parseWendoverOrderText", () => {
  const order = parseWendoverOrderText(FIXTURE);

  it("reads the header through the non-breaking space Gmail emits", () => {
    // Regression: "Your Order #..." — a pattern written with an ordinary
    // space silently yields a blank order number, which is the PO Reference.
    expect(order.orderNumber).toBe("1000292821");
    expect(order.orderDate).toBe("Jul 13, 2026, 12:26:21 PM");
    expect(order.vendorName).toBe(WENDOVER_VENDOR_NAME);
    expect(order.printedSubtotal).toBe(2753.22);
  });

  it("parses every item with no warnings", () => {
    expect(order.warnings).toEqual([]);
    expect(order.items.map((i) => i.sku)).toEqual(["WLD3511", "WAN2552", "WAN2555", "WFL1944"]);
  });

  it("treats the printed Price as a LINE TOTAL and derives the unit cost", () => {
    // The whole reason this parser exists: 3 x $1,057.62 would be $3,172.86,
    // and the printed subtotal proves otherwise.
    const first = order.items[0];
    expect(first.qty).toBe(3);
    expect(first.lineTotal).toBe(1057.62);
    expect(first.unitPrice).toBe(352.54);
  });

  it("pairs a price printed BEFORE its own SKU line with the right item", () => {
    // Page-break shape: "Patterned Dignity 4 3$745.20" precedes "SKU: WAN2555".
    // A "next price after a SKU" rule would give WAN2552 two prices and
    // WAN2555 none. Note the subtotal check cannot catch this — a sum is
    // order-independent — so this assertion is the only guard.
    const wan2555 = order.items.find((i) => i.sku === "WAN2555");
    expect(wan2555?.name).toBe("Patterned Dignity 4");
    expect(wan2555?.qty).toBe(3);
    expect(wan2555?.unitPrice).toBe(248.4);

    const wan2552 = order.items.find((i) => i.sku === "WAN2552");
    expect(wan2552?.name).toBe("Patterned Dignity 1");
    expect(wan2552?.lineTotal).toBe(745.2);
  });

  it("takes the product name from the line above the SKU", () => {
    expect(order.items[0].name).toBe("Before the Rain Customized");
  });

  it("reads labelled fields, and never mistakes a value for a label", () => {
    // "Canvas" and "Matte Paper" are short title-case lines that look just
    // like labels — a heuristic would swallow the following line.
    const first = order.items[0];
    expect(first.medium).toBe("Canvas");
    expect(first.treatment).toBe("Gallery Wrapped, Artist Enhanced");
    expect(first.size).toBe('35.01"w x 41.01"h');
    expect(first.frame).toBe('M1123, Antique Silver, 0.38"w x 2.13"d');
  });

  it("captures the Side Mark that means the piece is already sold", () => {
    const sold = order.items.find((i) => i.sku === "WFL1944");
    expect(sold?.sideMark).toBe("SBOM41649/Erin Kelly");
    expect(sold?.extras).toEqual(['Bottom Mat: B97, Polar White, 3"']);
  });

  it("drops the print's page furniture rather than reading it as a value", () => {
    const wan2555 = order.items.find((i) => i.sku === "WAN2555");
    expect(wan2555?.medium).toBe("Matte Paper");
  });

  it("line totals reconcile to the printed subtotal", () => {
    const sum = order.items.reduce((s, i) => s + i.lineTotal, 0);
    expect(sum).toBeCloseTo(order.printedSubtotal, 2);
  });

  it("warns LOUDLY when the document carries no subtotal at all", () => {
    // Fail loud, not open. A truncated document (Gmail clips long messages,
    // and a clipped confirmation prints without its tail) loses BOTH the
    // last items and the totals block — so the amount check would silently
    // pass on exactly the input it exists to catch, and the tool would emit
    // a short PO with zero warnings.
    const truncated = parseWendoverOrderText(
      ["Your Order #1000292821", "Before the Rain", "SKU: WLD3511", "3$1,057.62"].join("\n"),
    );
    expect(truncated.items).toHaveLength(1);
    expect(truncated.printedSubtotal).toBe(0);
    expect(truncated.warnings.some((w) => w.includes("no printed subtotal was found"))).toBe(true);
    expect(truncated.warnings.some((w) => w.includes("cut short"))).toBe(true);
  });

  it("warns when the calculated total misses the printed subtotal", () => {
    const bad = parseWendoverOrderText(
      ["Your Order #5", "SKU: A1", "Medium", "Canvas", "2$100.00", "Subtotal $999.00"].join("\n"),
    );
    expect(bad.warnings.some((w) => w.includes("does not match the printed subtotal"))).toBe(true);
  });

  it("warns rather than silently rounding when a total will not divide by qty", () => {
    // $100.00 over 3 is $33.333...; the rounded unit re-multiplies to
    // $99.99, so the PO would no longer equal what the vendor charges.
    const odd = parseWendoverOrderText(
      ["Your Order #5", "Odd One", "SKU: A1", "3$100.00"].join("\n"),
    );
    expect(odd.items[0].unitPrice).toBe(33.33);
    expect(odd.warnings.some((w) => w.includes("does not divide evenly"))).toBe(true);
  });

  it("warns when an item never receives a price", () => {
    const orphan = parseWendoverOrderText(
      ["Your Order #5", "Nameless", "SKU: A1", "Medium", "Canvas"].join("\n"),
    );
    expect(orphan.warnings.some((w) => w.includes("no quantity or price"))).toBe(true);
  });

  it("refuses to split a name that ends in digits into a quantity", () => {
    // "Item43$745.20" has no separating space: parsing it would invent
    // qty 43. Refusing, and reporting the priceless item, is correct.
    const ambiguous = parseWendoverOrderText(
      ["Your Order #5", "SKU: A1", "Item43$745.20"].join("\n"),
    );
    expect(ambiguous.items[0].qty).toBe(0);
    expect(ambiguous.warnings.some((w) => w.includes("no quantity or price"))).toBe(true);
  });
});
