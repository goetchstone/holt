// /app/__tests__/simblistCsvOrderParser.test.ts
//
// The fixture is the real Simblist Group / Maison Zoe Ford export (PON09047, 5
// items). It keeps the two-table shape (order-header pair + item table) and the
// order-level discount (line totals summing above the order total) that the
// parser must surface rather than silently apply.

import { parseSimblistCsvText } from "@/lib/pricing/simblistCsvOrderParser";

const FIXTURE = [
  "RepGroup,Manufacturer,PO #,Order Date,Request Date,Ship Date,Cancel Date,Order Total,Customer Name",
  "Simblist Group,MAISON ZOE FORD,PON09047,2026-06-11,2026-09-01,2026-09-01,,722.74,SAYBROOK HOME",
  "Sequence #,Item Number,Name,Description,Quantity,Unit Price,Unit Qty,Item Discount,UPC,Unit of measure,Size,Color,Style,Notes,Retailer Item Number,List Price,Item Status,Extended Price,Total Price",
  '3,ZFUSA03-C,Big Time Brownie Mix - case pack of 6,,2,53.94,,0.0,10628678860152,,,,,"Only available to ship on September 1, 2026",,17.99,,,$107.88',
  "6,ZFUSA07-C,Speedy Cinnamon Roll Mix - case pack of 6,,2,41.94,,0.0,10628678860176,,,,,,,13.99,,,$83.88",
  "1,ZFUSA13-C,Extraordinary Brownie Hot Chocolate,,6,71.92,,0.0,10628678860213,,,,,,,17.99,,,$431.52",
  "2,ZFUSA20-C,Quick Focaccia Style Flatbread Mix,,2,35.94,,0.0,10628678860299,,,,,,,11.99,,,$71.88",
  "5,ZFUSA21-C,Outrageous Ginger Cookie Mix - case pack of 6,,2,53.94,,0.0,10628678860336,,,,,,,17.99,,,$107.88",
].join("\n");

describe("parseSimblistCsvText", () => {
  const order = parseSimblistCsvText(FIXTURE);

  it("reads the manufacturer, rep group, and PO from the order-header row", () => {
    expect(order.vendorName).toBe("MAISON ZOE FORD");
    expect(order.repGroup).toBe("Simblist Group");
    expect(order.poNumber).toBe("PON09047");
    expect(order.shipDate).toBe("2026-09-01");
    expect(order.printedTotal).toBeCloseTo(722.74, 2);
  });

  it("reads columns by name and confirms qty x Unit Price == Total Price", () => {
    expect(order.items).toHaveLength(5);
    const brownie = order.items.find((i) => i.itemNumber === "ZFUSA03-C");
    expect(brownie).toMatchObject({
      qty: 2,
      unitPrice: 53.94,
      lineTotal: 107.88,
      listPrice: 17.99,
    });
    expect(brownie?.upc).toBe("10628678860152");
  });

  it("carries a ship-caveat note through", () => {
    const brownie = order.items.find((i) => i.itemNumber === "ZFUSA03-C");
    expect(brownie?.notes).toBe("Only available to ship on September 1, 2026");
  });

  it("surfaces the order-level discount rather than applying it", () => {
    // Line totals sum to 803.04; order total is 722.74 -> an 80.30 discount.
    const lineSum = order.items.reduce((s, i) => s + i.lineTotal, 0);
    expect(lineSum).toBeCloseTo(803.04, 2);
    expect(order.warnings.some((w) => w.includes("order-level discount of 80.30"))).toBe(true);
  });

  it("warns when it cannot find the item table", () => {
    const bad = parseSimblistCsvText("RepGroup,Manufacturer\nSimblist,X");
    expect(bad.items).toHaveLength(0);
    expect(bad.warnings.some((w) => w.includes("Could not find the item table"))).toBe(true);
  });

  it("flags a line whose qty x price does not equal its total", () => {
    const bad = parseSimblistCsvText(
      [
        "RepGroup,Manufacturer,PO #,Order Total",
        "Simblist,X Co,PON1,20.00",
        "Item Number,Name,Quantity,Unit Price,UPC,Total Price",
        "AB-1,Widget,2,10.00,123,$999.00",
      ].join("\n"),
    );
    expect(bad.items).toHaveLength(0);
    expect(bad.warnings.some((w) => w.includes("does not equal the line total"))).toBe(true);
  });
});
