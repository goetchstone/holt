// /app/__tests__/kkOrderParser.test.ts
//
// Pins the K & K Interiors "Order Detail" bundle parser against synthetic
// fixtures built from the verified OEORD_BUNDLE layout (real extraction:
// 2 orders / 28 items / customerPo PON09025 / zero warnings, printed totals
// reconciling to the penny). Fixtures below are minimal reconstructions of
// that layout, not the real PDF text.

import { KK_VENDOR_NAME, parseKKOrderText } from "@/lib/pricing/kkOrderParser";

// Order 0001111111: two items.
//   AAA111  1,234.56 EA x 2 = 2469.12  (comma price, 3-line description)
//   BBB222     79.99 EA x 2 =  159.98  (uom EA but a "Set of" description)
//   order total                        2629.10
// Order 0002222222: one item.
//   CCC333     50.00 SET x 3 =  150.00
const HAPPY_PATH = `
Date:   Jun 15, 2026
Order Number: 0001111111
PON5001
PB#INFO [BUNDORD], [],[0001111111],[0.00],[Test Co],[],[test@example.com]
1,234.56EA
AAA111
1/1/27 2
0.00
2.00
Fancy Multi-Line
Description Continues
Here
UPC: 111111111111
*111111111111*
79.99EA
BBB222
1/1/27 2
0.00
2.00
Set of 3 Stackable Widgets
UPC: 222222222222
*222222222222*
PB#INFO [BUNDORD], [],[0001111111],[2629.10],[Test Co],[],[test@example.com]
Order Number: 0002222222
PON5001
PB#INFO [BUNDORD], [],[0002222222],[0.00],[Test Co],[],[test@example.com]
50.00SET
CCC333
1/1/27 3
0.00
3.00
Set of 4 Widgets
UPC: 333333333333
*333333333333*
PB#INFO [BUNDORD], [],[0002222222],[150.00],[Test Co],[],[test@example.com]
`;

describe("parseKKOrderText — happy path bundle", () => {
  const bundle = parseKKOrderText(HAPPY_PATH);

  it("returns no vendor name -- the PDF carries no vendor text line", () => {
    expect(bundle.vendorName).toBe("");
    expect(KK_VENDOR_NAME).toBe("K & K Interiors");
  });

  it("captures the customer PO and order date (first occurrence)", () => {
    expect(bundle.customerPo).toBe("PON5001");
    expect(bundle.orderDate).toBe("Jun 15, 2026");
  });

  it("splits the bundle into two distinct orders with the right items", () => {
    expect(bundle.orders).toHaveLength(2);
    expect(bundle.orders[0].orderNumber).toBe("0001111111");
    expect(bundle.orders[0].items.map((i) => i.itemNumber)).toEqual(["AAA111", "BBB222"]);
    expect(bundle.orders[1].orderNumber).toBe("0002222222");
    expect(bundle.orders[1].items.map((i) => i.itemNumber)).toEqual(["CCC333"]);
  });

  it("maps every field of a block, including a comma'd price and a wrapped description", () => {
    const item = bundle.orders[0].items[0];
    expect(item).toEqual({
      itemNumber: "AAA111",
      description: "Fancy Multi-Line Description Continues Here",
      uom: "EA",
      unitPrice: 1234.56,
      qty: 2,
      requiredDate: "1/1/27",
      upc: "111111111111",
    });
  });

  it("reports uom faithfully and never infers set-ness from it", () => {
    const item = bundle.orders[0].items[1];
    expect(item.uom).toBe("EA");
    expect(item.description).toBe("Set of 3 Stackable Widgets");
  });

  it("sets the order's requiredDate from its first item", () => {
    expect(bundle.orders[0].requiredDate).toBe("1/1/27");
    expect(bundle.orders[1].requiredDate).toBe("1/1/27");
  });

  it("keeps the LAST PB#INFO total per order, not the early [0.00] one", () => {
    expect(bundle.orders[0].printedTotal).toBe(2629.1);
    expect(bundle.orders[1].printedTotal).toBe(150);
  });

  it("reconciles cleanly with zero warnings", () => {
    expect(bundle.warnings).toEqual([]);
  });
});

describe("parseKKOrderText — malformed required-date/qty line", () => {
  // BADITEM1's date/qty line is garbage; GOODITEM1 immediately follows and
  // must still parse -- the skip is scoped to the one bad block.
  const fixture = `
Date:   Jun 15, 2026
Order Number: 0003333333
PON6002
PB#INFO [BUNDORD], [],[0003333333],[0.00],[Test Co],[],[test@example.com]
10.00EA
BADITEM1
this-is-not-a-date-line
99.99EA
GOODITEM1
1/1/27 5
0.00
5.00
Perfectly Fine Widget
UPC: 444444444444
*444444444444*
PB#INFO [BUNDORD], [],[0003333333],[499.95],[Test Co],[],[test@example.com]
`;
  const bundle = parseKKOrderText(fixture);

  it("skips only the malformed block and keeps parsing the next one", () => {
    expect(bundle.orders).toHaveLength(1);
    expect(bundle.orders[0].items.map((i) => i.itemNumber)).toEqual(["GOODITEM1"]);
  });

  it("names the malformed item in a warning", () => {
    expect(bundle.warnings).toHaveLength(1);
    expect(bundle.warnings[0]).toContain("BADITEM1");
  });

  it("reconciles the surviving item against the printed total with no extra warning", () => {
    expect(bundle.orders[0].printedTotal).toBe(499.95);
  });
});

describe("parseKKOrderText — reconciliation", () => {
  it("warns, naming the order and both totals, when the printed total does not match", () => {
    const fixture = `
Date:   Jun 15, 2026
Order Number: 0004444444
PON7003
PB#INFO [BUNDORD], [],[0004444444],[0.00],[Test Co],[],[test@example.com]
25.00EA
MISMATCH1
1/1/27 4
0.00
4.00
Mismatched Total Widget
UPC: 555555555555
*555555555555*
PB#INFO [BUNDORD], [],[0004444444],[999.99],[Test Co],[],[test@example.com]
`;
    const bundle = parseKKOrderText(fixture);
    expect(bundle.warnings).toHaveLength(1);
    expect(bundle.warnings[0]).toContain("0004444444");
    expect(bundle.warnings[0]).toContain("100.00");
    expect(bundle.warnings[0]).toContain("999.99");
  });

  it("never guesses or flags when the printed total is 0 or missing", () => {
    const fixture = `
Date:   Jun 15, 2026
Order Number: 0005555555
PON8004
PB#INFO [BUNDORD], [],[0005555555],[0.00],[Test Co],[],[test@example.com]
10.00EA
ZEROTOTAL1
1/1/27 2
0.00
2.00
No Printed Total Widget
UPC: 666666666666
*666666666666*
`;
    const bundle = parseKKOrderText(fixture);
    expect(bundle.orders[0].printedTotal).toBe(0);
    expect(bundle.warnings).toEqual([]);
  });
});

describe("PB#INFO total resolution — LAST wins, not biggest", () => {
  // The real document's totals only ever climb (0.00 -> real total), so a
  // max-wins bug is invisible to any fixture that mirrors it: an adversarial
  // review mutated the parser to Math.max(...) and the whole suite still
  // passed. This fixture prints a LARGER total on an earlier page than the
  // order's true final one, which only a genuine last-wins reader survives.
  const fixture = `
Date:   Jun 15, 2026
Order Number: 0007777777
PON9999
PB#INFO [BUNDORD], [],[0007777777],[0.00],[Test Co],[],[test@example.com]
PB#INFO [BUNDORD], [],[0007777777],[99999.00],[Test Co],[],[test@example.com]
25.00EA
LASTWINS1
1/1/27 4
0.00
4.00
Last Wins Widget
UPC: 777777777777
*777777777777*
PB#INFO [BUNDORD], [],[0007777777],[100.00],[Test Co],[],[test@example.com]
`;

  it("takes the final printed total even when an earlier one is larger", () => {
    const bundle = parseKKOrderText(fixture);
    expect(bundle.orders[0].printedTotal).toBe(100);
  });

  it("reconciles against that final total, not the larger earlier one", () => {
    // 25.00 x 4 = 100.00 matches the LAST total exactly. A max-wins reader
    // would compare against 99999.00 and wrongly warn.
    const bundle = parseKKOrderText(fixture);
    expect(bundle.warnings).toEqual([]);
  });
});

describe("branches the real document never exercises", () => {
  it("leaves upc empty when a block prints no UPC line, and still parses the next block", () => {
    const fixture = `
Date:   Jun 15, 2026
Order Number: 0008888888
PON8888
5.00EA
NOUPC1
1/1/27 2
0.00
2.00
Widget With No Barcode Line
7.00EA
HASUPC1
1/1/27 3
0.00
3.00
Widget With A Barcode
UPC: 888888888888
*888888888888*
`;
    const bundle = parseKKOrderText(fixture);
    expect(bundle.orders[0].items).toHaveLength(2);
    expect(bundle.orders[0].items[0].itemNumber).toBe("NOUPC1");
    expect(bundle.orders[0].items[0].upc).toBe("");
    expect(bundle.orders[0].items[0].description).toBe("Widget With No Barcode Line");
    expect(bundle.orders[0].items[1].upc).toBe("888888888888");
  });

  it("warns and skips an item that appears before any order header", () => {
    const fixture = `
Date:   Jun 15, 2026
9.00EA
ORPHAN1
1/1/27 2
0.00
2.00
Orphan Widget
UPC: 999999999999
*999999999999*
`;
    const bundle = parseKKOrderText(fixture);
    expect(bundle.orders).toHaveLength(0);
    expect(bundle.warnings).toHaveLength(1);
    expect(bundle.warnings[0]).toContain("ORPHAN1");
  });
});
