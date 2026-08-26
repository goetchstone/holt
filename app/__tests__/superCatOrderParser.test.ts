// /app/__tests__/superCatOrderParser.test.ts
//
// The fixture's LAYOUT is condensed from a real SuperCatSolutions order; the
// contact, the reference and every price are invented, since this repo is
// public and a vendor's dealer costs are confidential. It keeps
// the shapes a naive parser gets wrong: the item-number/qty boundary with no
// separator (a qty digit right after an item number that itself ends in digits),
// the order-level discount, and the promotional line that must not be read as an
// item.

import { parseSuperCatOrderText } from "@/lib/pricing/superCatOrderParser";

const FIXTURE = [
  "Page 1/2Powered by SuperCatSolutions.comVisit www.jamieyoung.com",
  "Dana Whitfield Company",
  "331 W Victoria Street",
  "Ref #:990001-070126-175-1",
  "Submit Date:",
  "Cust PO:",
  "Ship Date:",
  "7/1/26",
  "EMAIL",
  "8/11/26",
  "Item #QtyPriceExt. PriceDescription",
  "9BOATLINEG6$210.00$1,260.00January New - Boa Table Lamp",
  // item number ends in digits+letters; qty digit right after, no separator
  "9KAYABLD71CL4$320.00$1,280.00Kaya Table Lamp",
  // multi-digit qty and a dashed item number
  "20BRAD-BSSA4$450.00$1,800.00Bradbury Bar Stool",
  // promotional line — "10%" then no "$price$ext" pair — must be skipped
  "ATLS2610%1Receive a 10% discount on orders over $3,500 as p...",
  "Merchandise Subtotal$4,340.00",
  "Order Discount-$434.00",
  "Grand Total$3,906.00",
].join("\n");

describe("parseSuperCatOrderText", () => {
  const order = parseSuperCatOrderText(FIXTURE);

  it("reads the vendor from the document and the order reference", () => {
    expect(order.vendorName).toBe("Dana Whitfield Company");
    expect(order.orderNumber).toBe("990001-070126-175-1");
  });

  it("picks the order date and ship date out of the label-less value block", () => {
    expect(order.orderDate).toBe("7/1/26");
    expect(order.shipDate).toBe("8/11/26");
  });

  it("splits item / qty / price / extension on a run-together line", () => {
    const boa = order.items.find((i) => i.itemNumber === "9BOATLINEG");
    expect(boa).toMatchObject({ qty: 6, unitPrice: 210, lineTotal: 1260 });
    expect(boa?.name).toBe("January New - Boa Table Lamp");
  });

  it("finds the qty when the item number itself ends in digits", () => {
    // "9KAYABLD71CL4$..." — the qty is 4, NOT part of the "71".
    const kaya = order.items.find((i) => i.itemNumber === "9KAYABLD71CL");
    expect(kaya).toMatchObject({ qty: 4, unitPrice: 320, lineTotal: 1280 });
  });

  it("handles a multi-digit qty after a dashed item number", () => {
    const stool = order.items.find((i) => i.itemNumber === "20BRAD-BSSA");
    expect(stool).toMatchObject({ qty: 4, unitPrice: 450, lineTotal: 1800 });
  });

  it("skips the promotional line, keeping only real items", () => {
    expect(order.items).toHaveLength(3);
    expect(order.items.some((i) => i.itemNumber.startsWith("ATLS"))).toBe(false);
  });

  it("carries no UPC — barcode is Ordorite's to assign", () => {
    expect(order.items.every((i) => !("upc" in i))).toBe(true);
  });

  it("warns about an order-level discount rather than silently applying it", () => {
    expect(order.orderDiscount).toBeCloseTo(434, 2);
    expect(order.warnings.some((w) => w.includes("order-level discount"))).toBe(true);
  });

  it("warns when the line totals do not match the merchandise subtotal", () => {
    const bad = parseSuperCatOrderText(
      [
        "Powered by SuperCatSolutions.com",
        "X Co",
        "Item #QtyPriceExt. PriceDescription",
        "AB12$10.00$20.00Widget",
        "Merchandise Subtotal$999.00",
      ].join("\n"),
    );
    expect(bad.warnings.some((w) => w.includes("does not match the merchandise subtotal"))).toBe(
      true,
    );
  });
});
