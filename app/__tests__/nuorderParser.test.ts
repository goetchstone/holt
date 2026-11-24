// /app/__tests__/nuorderParser.test.ts
//
// The nuORDER order-confirmation parser's header, footer and item reads, on the
// layout its comments describe (values invented). Its regexes over the whole text
// bound every run that crosses "\n", or "PO" followed by 50 lines of spaces takes
// seconds (the timing properties in fuzz/vendorOrderParsers.fuzz.test.ts); this
// pins that the bounded regexes still read the shapes a confirmation prints.

import { parseNuOrderText } from "@/lib/pricing/nuorderParser";

const CONFIRMATION = [
  "Order #: 7000001",
  "Order Date: JAN 05, 2026",
  "PO #: PON00006",
  "Delivery: 03/01/2026 - 03/15/2026",
  "Terms: Net 30",
  "Pat Doe",
  "pat@example.com",
  "THE EASY TEE",
  "Style #: ET100BLK",
  "MSRP: $98.00",
  "Season: spring 2026",
  "Color: black",
  "Color Code: BLK",
  "$38.50 3 $115.50",
  "Sizes: S: 1 M: 1 L: 1",
  "WIDE LEG PANT",
  "Style #: WL200NVY",
  "MSRP: $148.00",
  "Season: spring 2026",
  "Color: navy",
  "Color Code: NVY",
  "$58.00 2 $116.00",
  "Sizes:",
  "25: 1 26: 1",
  "Total Units: 5",
  "Total Price: $231.50",
  "Sample Brand * Los Angeles CA 90014",
];

describe("parseNuOrderText", () => {
  const po = parseNuOrderText(CONFIRMATION.join("\n"));

  it("reads the order header, and the vendor from the footer", () => {
    expect(po).toMatchObject({
      vendorName: "Sample Brand",
      orderNumber: "7000001",
      orderDate: "JAN 05, 2026",
      poNumber: "PON00006",
      deliveryStart: "03/01/2026",
      deliveryEnd: "03/15/2026",
      terms: "Net 30",
      buyerName: "Pat Doe",
      buyerEmail: "pat@example.com",
      totalUnits: 5,
      totalPrice: 231.5,
      warnings: [],
    });
  });

  it("reads sizes printed on the Sizes: line and on the line after it", () => {
    expect(po.items.map((i) => [i.styleNumber, i.sizes])).toEqual([
      [
        "ET100BLK",
        [
          { size: "S", quantity: 1 },
          { size: "M", quantity: 1 },
          { size: "L", quantity: 1 },
        ],
      ],
      [
        "WL200NVY",
        [
          { size: "25", quantity: 1 },
          { size: "26", quantity: 1 },
        ],
      ],
    ]);
  });

  it("reads a value a few blank lines below its label", () => {
    const spaced = parseNuOrderText(
      [
        "Order #:",
        "",
        "7000001",
        "PO #:",
        "",
        "PON00006",
        "Style #: A1",
        "Sizes:",
        "",
        "M: 2",
      ].join("\n"),
    );
    expect([spaced.orderNumber, spaced.poNumber]).toEqual(["7000001", "PON00006"]);
    expect(spaced.items[0].sizes).toEqual([{ size: "M", quantity: 2 }]);
  });
});
