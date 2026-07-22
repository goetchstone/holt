// /app/__tests__/frankEileenParser.test.ts
//
// Pins the Frank & Eileen order-acknowledgement parser against a fixture
// lifted VERBATIM (including whitespace) from the real Spring 2026 ack
// 1949021 pdf-parse extraction. The column-offset spacing is the contract:
// per-size quantities are right-aligned to their size labels, so editing
// the fixture's spaces breaks the thing the test exists to pin.

import { parseFrankEileenText } from "@/lib/pricing/frankEileenParser";

const HEADER = `FRANK & EILEEN
843 S. Los Angeles St.
#500
Los Angeles CA 90014
Phone 213-623-1345
*****REPRINT*****
194902104/13/26
Page: 1 of 1
SAYBROOK HOME
2 MAIN STREETSAYBROOK HOME
OLD SAYBROOK, CT  064752 MAIN STREET
OLD SAYBROOK, CT  06475
Phone: 860-388-0891Fax: 860-388-3692
SAYBROSpring 202610/07/2506/01/2606/15/26UPS GROUND
18573341PRE-PAID CREETT  Erica TrinHOUS HOUSEEFFI Effie Vals`;

// 4+3+5+7+2 = 21 units; 448+336+560+1057+286 = 2687.00
const FIXTURE = `${HEADER}
EILEEN
PRBG
Relaxed Button-Up Shirt Pink Red Blue Flowers
  XXS   XS    S    M    L   XL
0010_
    1    1    1    1 112.00     4   448.00
EILEEN
WTQS
Relaxed Button-Up Shirt White Turquoise Stripe
  XXS   XS    S    M    L   XL
0250_
    1    1    1 112.00     3   336.00
EILEEN
SFBF
Relaxed Button-Up Shirt Small Flowers Big Flowers
  XXS   XS    S    M    L   XL
0670_
    1    1    2    1 112.00     5   560.00
WVILLAGE
CMTL
West Village - NYC Trouser Cement
   00    0    2    4    6    8   10   12   14
0710_
    1    1    2    1    1    1 151.00     7  1057.00
MEGAN
F000
One-Size Maxi Shirtdress WHITE VOILE
  O/S
1420OS
    2 143.00     2   286.00
Merchandise USD Total     21   2687.00
`;

describe("parseFrankEileenText — header fields", () => {
  const order = parseFrankEileenText(FIXTURE);

  it("splits the concatenated ack number + date", () => {
    expect(order.ackNumber).toBe("1949021");
  });

  it("reads the customer P.O. off the terms line", () => {
    expect(order.poNumber).toBe("18573341");
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
    expect(order.totalPrice).toBe(2687);
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
    expect(byLine("WVILLAGE", "CMTL").unitPrice).toBe(151);
    expect(byLine("WVILLAGE", "CMTL").totalPrice).toBe(1057);
  });

  it("handles the O/S one-size scale (1420OS)", () => {
    expect(byLine("MEGAN", "F000").sizes).toEqual([{ size: "O/S", quantity: 2 }]);
  });
});

describe("parseFrankEileenText — refuses to guess", () => {
  it("drops a line whose quantities do not sum to its own UNITS column", () => {
    // Same 0250_ block but the UNITS column says 4 while only 3 map.
    const corrupted = FIXTURE.replace(
      "    1    1    1 112.00     3   336.00",
      "    1    1    1 112.00     4   448.00",
    );
    const order = parseFrankEileenText(corrupted);
    expect(order.items).toHaveLength(4);
    expect(order.items.find((i) => i.colorCode === "WTQS")).toBeUndefined();
    expect(order.warnings.some((w) => w.includes("EILEEN-WTQS"))).toBe(true);
    // And the grand total no longer reconciles, which is also surfaced.
    expect(order.warnings.some((w) => w.includes("document total"))).toBe(true);
  });
});
