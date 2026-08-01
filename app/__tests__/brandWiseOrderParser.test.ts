// /app/__tests__/brandWiseOrderParser.test.ts
//
// The fixture is condensed from the real Zodax BrandWise order (B31669979 /
// PON09029, 8 items, $3,322.00). It keeps the two shapes that a naive parser
// gets wrong: the money line with no "$", and the fully-concatenated single
// line with an inch-mark digit right before the qty.

import { parseBrandWiseOrderText } from "@/lib/pricing/brandWiseOrderParser";

const FIXTURE = [
  "CUSTOMER OC",
  "Sales Order No.B31669979",
  "Order TypeBrandWise Sales Orders",
  "F.O.B POINTSHIP VIABUYERSHIP DATECANCEL DATECUST P.O. NO.",
  "Panorama City, CAFedEx GroundSarah Levatino8/24/20266/10/2027PON09029",
  "ORDER DATETERMSSALES PERSONSTORE #",
  "6/10/2026Net 30 DaysAPS00    Atlanta Showroom",
  "IMAGESKUDESCRIPTIONQTY ORDUNITS",
  // multi-line item, description wraps
  'IN-8222The Cadier Wooden Wall Mirrors  23.75" x',
  '35.5"',
  "4EA200.00800.00",
  "Available Qty:21",
  "Incoming Qty:0",
  // fully-concatenated single line, inch mark right before the qty
  'IN-8432Chevron Wood Box- 13"x 6.5"x 3.25"4EA57.00228.00',
  "Available Qty:50",
  "TOTAL IN US$:",
  "1,028.00",
  "Page: 2 of 2",
].join("\n");

describe("parseBrandWiseOrderText", () => {
  const order = parseBrandWiseOrderText(FIXTURE);

  it("reads the sales order number and the customer PO", () => {
    expect(order.salesOrderNo).toBe("B31669979");
    expect(order.poNumber).toBe("PON09029");
  });

  it("captures the total even when the label and value split across two lines", () => {
    expect(order.printedTotal).toBe(1028);
  });

  it("parses a money line that has no dollar sign", () => {
    // "4EA200.00800.00" -> qty 4, UOM EA, price 200.00, total 800.00. The split
    // is settled by qty x price == total, since there is no "$" to lean on.
    const mirror = order.items.find((i) => i.sku === "IN-8222");
    expect(mirror).toMatchObject({ qty: 4, uom: "EA", unitPrice: 200, lineTotal: 800 });
    expect(mirror?.name).toBe('The Cadier Wooden Wall Mirrors 23.75" x 35.5"');
  });

  it("splits a fully-concatenated line despite an inch mark before the qty", () => {
    // "...3.25\"4EA57.00228.00" — the "4" is the qty, not part of "3.25".
    const box = order.items.find((i) => i.sku === "IN-8432");
    expect(box).toMatchObject({ qty: 4, unitPrice: 57, lineTotal: 228 });
    expect(box?.name).toBe('Chevron Wood Box- 13"x 6.5"x 3.25"');
  });

  it("carries no UPC — barcode is Ordorite's to assign", () => {
    // The document has no UPC column; the parser exposes only the SKU.
    expect(order.items.every((i) => !("upc" in i))).toBe(true);
  });

  it("reconciles the line totals against the printed total", () => {
    const sum = order.items.reduce((s, i) => s + i.lineTotal, 0);
    expect(sum).toBeCloseTo(order.printedTotal, 2);
    expect(order.warnings).toEqual([]);
  });

  it("warns when the line totals do not match the printed total", () => {
    const bad = parseBrandWiseOrderText(
      ["Sales Order No.B1", "IN-1A widget4EA10.0040.00", "TOTAL IN US$:", "999.00"].join("\n"),
    );
    expect(bad.warnings.some((w) => w.includes("does not match the printed total"))).toBe(true);
  });
});
