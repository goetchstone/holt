// /app/__tests__/frankEileenParser.test.ts
//
// Pins the Frank & Eileen order-acknowledgement parser against a fixture whose
// LAYOUT is taken from a real pdf-parse extraction and whose CONTENT is not.
// The column-offset spacing is the contract -- per-size quantities are
// right-aligned to their size labels -- so the whitespace, the concatenation
// artefacts and every field width are preserved character for character.
//
// The buyer, the reps, the document numbers and the unit prices are invented.
// This is a public repository: an ack carries a named business's address and a
// vendor's confidential dealer pricing, and neither is needed to test a parser.
// The parser never reads the address block at all (it looks for the size-column
// header, the item lines, and a season/date line), so swapping it costs nothing.
//
// If you need to reproduce a real ack, do it locally -- do not commit it.

import { parseFrankEileenText } from "@/lib/pricing/frankEileenParser";

const HEADER = `FRANK & EILEEN
843 S. Los Angeles St.
#500
Los Angeles CA 90014
Phone 213-555-0134
*****REPRINT*****
221044704/13/26
Page: 1 of 1
RIVERBEND HOME
14 CANAL STREETRIVERBEND HOME
MILLBROOK FALLS, VT  0561414 CANAL STREET
MILLBROOK FALLS, VT  05614
Phone: 802-555-0142Fax: 802-555-0143
RIVERBSpring 202610/07/2506/01/2606/15/26UPS GROUND
19900001PRE-PAID CREETT  Dana WhitlHOUS HOUSEROBN Robin Sant`;

// 4+3+5+7+2 = 21 units; 512+384+640+1162+308 = 3006.00
const FIXTURE = `${HEADER}
EILEEN
PRBG
Relaxed Button-Up Shirt Pink Red Blue Flowers
  XXS   XS    S    M    L   XL
0010_
    1    1    1    1 128.00     4   512.00
EILEEN
WTQS
Relaxed Button-Up Shirt White Turquoise Stripe
  XXS   XS    S    M    L   XL
0250_
    1    1    1 128.00     3   384.00
EILEEN
SFBF
Relaxed Button-Up Shirt Small Flowers Big Flowers
  XXS   XS    S    M    L   XL
0670_
    1    1    2    1 128.00     5   640.00
WVILLAGE
CMTL
West Village - NYC Trouser Cement
   00    0    2    4    6    8   10   12   14
0710_
    1    1    2    1    1    1 166.00     7  1162.00
MEGAN
F000
One-Size Maxi Shirtdress WHITE VOILE
  O/S
1420OS
    2 154.00     2   308.00
Merchandise USD Total     21   3006.00
`;

describe("parseFrankEileenText — header fields", () => {
  const order = parseFrankEileenText(FIXTURE);

  it("splits the concatenated ack number + date", () => {
    expect(order.ackNumber).toBe("2210447");
  });

  it("reads the customer P.O. off the terms line", () => {
    expect(order.poNumber).toBe("19900001");
  });

  it("reads season and the three header dates", () => {
    expect(order.season).toBe("Spring 2026");
    expect(order.orderDate).toBe("10/07/25");
    expect(order.deliveryStart).toBe("06/01/26");
    expect(order.deliveryEnd).toBe("06/15/26");
  });

  it("uses the catalog vendor name, not the PDF's FRANK & EILEEN", () => {
    expect(order.vendorName).toBe("Frank and Eileen");
  });

  it("reads the merchandise total line", () => {
    expect(order.totalUnits).toBe(21);
    expect(order.totalPrice).toBe(3006);
  });

  it("parses every line cleanly (no warnings on the real layout)", () => {
    expect(order.warnings).toEqual([]);
    expect(order.items).toHaveLength(5);
  });
});

describe("parseFrankEileenText — size-column alignment", () => {
  const order = parseFrankEileenText(FIXTURE);
  const byLine = (style: string, color: string) =>
    order.items.find((i) => i.styleNumber === style && i.colorCode === color)!;

  it("maps a full 4-of-6 alpha row (0010_) to XXS/XS/S/M", () => {
    expect(byLine("EILEEN", "PRBG").sizes).toEqual([
      { size: "XXS", quantity: 1 },
      { size: "XS", quantity: 1 },
      { size: "S", quantity: 1 },
      { size: "M", quantity: 1 },
    ]);
  });

  it("maps a 3-of-6 row (0250_) to the LEFT columns, not just any three", () => {
    expect(byLine("EILEEN", "WTQS").sizes).toEqual([
      { size: "XXS", quantity: 1 },
      { size: "XS", quantity: 1 },
      { size: "S", quantity: 1 },
    ]);
  });

  it("keeps a qty of 2 on the right size (0670_, S column)", () => {
    const sizes = byLine("EILEEN", "SFBF").sizes;
    expect(sizes.find((s) => s.size === "S")?.quantity).toBe(2);
    expect(byLine("EILEEN", "SFBF").totalUnits).toBe(5);
  });

  it("handles the numeric pant scale 00–14 (0710_)", () => {
    expect(byLine("WVILLAGE", "CMTL").sizes).toEqual([
      { size: "00", quantity: 1 },
      { size: "0", quantity: 1 },
      { size: "2", quantity: 2 },
      { size: "4", quantity: 1 },
      { size: "6", quantity: 1 },
      { size: "8", quantity: 1 },
    ]);
    expect(byLine("WVILLAGE", "CMTL").unitPrice).toBe(166);
    expect(byLine("WVILLAGE", "CMTL").totalPrice).toBe(1162);
  });

  it("handles the O/S one-size scale (1420OS)", () => {
    expect(byLine("MEGAN", "F000").sizes).toEqual([{ size: "O/S", quantity: 2 }]);
  });
});

describe("parseFrankEileenText — refuses to guess", () => {
  it("drops a line whose quantities do not sum to its own UNITS column", () => {
    // Same 0250_ block but the UNITS column says 4 while only 3 map.
    const corrupted = FIXTURE.replace(
      "    1    1    1 128.00     3   384.00",
      "    1    1    1 128.00     4   512.00",
    );
    const order = parseFrankEileenText(corrupted);
    expect(order.items).toHaveLength(4);
    expect(order.items.find((i) => i.colorCode === "WTQS")).toBeUndefined();
    expect(order.warnings.some((w) => w.includes("EILEEN-WTQS"))).toBe(true);
    // And the grand total no longer reconciles, which is also surfaced.
    expect(order.warnings.some((w) => w.includes("document total"))).toBe(true);
  });
});
