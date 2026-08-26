// /app/__tests__/simblistCsvOrderParser.test.ts
//
// The fixture is a real Simblist Group / Maison Zoe Ford export (PO number and every
// price invented -- this repo is public and a vendor's dealer costs are
// confidential). It keeps the 5
// items). It keeps the two-table shape (order-header pair + item table) and the
// order-level discount (line totals summing above the order total) that the
// parser must surface rather than silently apply.

import { parseSimblistCsvText } from "@/lib/pricing/simblistCsvOrderParser";

const FIXTURE = [
  "RepGroup,Manufacturer,PO #,Order Date,Request Date,Ship Date,Cancel Date,Order Total,Customer Name",
  "Simblist Group,MAISON ZOE FORD,PON00001,2026-06-11,2026-09-01,2026-09-01,,615.60,RIVERBEND HOME",
  "Sequence #,Item Number,Name,Description,Quantity,Unit Price,Unit Qty,Item Discount,UPC,Unit of measure,Size,Color,Style,Notes,Retailer Item Number,List Price,Item Status,Extended Price,Total Price",
  '3,ZFUSA03-C,Big Time Brownie Mix - case pack of 6,,2,48.00,,0.0,10628678860152,,,,,"Only available to ship on September 1, 2026",,15.00,,,$96.00',
  "6,ZFUSA07-C,Speedy Cinnamon Roll Mix - case pack of 6,,2,36.00,,0.0,10628678860176,,,,,,,12.00,,,$72.00",
  "1,ZFUSA13-C,Extraordinary Brownie Hot Chocolate,,6,60.00,,0.0,10628678860213,,,,,,,15.00,,,$360.00",
  "2,ZFUSA20-C,Quick Focaccia Style Flatbread Mix,,2,30.00,,0.0,10628678860299,,,,,,,10.00,,,$60.00",
  "5,ZFUSA21-C,Outrageous Ginger Cookie Mix - case pack of 6,,2,48.00,,0.0,10628678860336,,,,,,,15.00,,,$96.00",
].join("\n");

describe("parseSimblistCsvText", () => {
  const order = parseSimblistCsvText(FIXTURE);

  it("reads the manufacturer, rep group, and PO from the order-header row", () => {
    expect(order.vendorName).toBe("MAISON ZOE FORD");
    expect(order.repGroup).toBe("Simblist Group");
    expect(order.poNumber).toBe("PON00001");
    expect(order.shipDate).toBe("2026-09-01");
    expect(order.printedTotal).toBeCloseTo(615.6, 2);
  });

  it("reads columns by name and confirms qty x Unit Price == Total Price", () => {
    expect(order.items).toHaveLength(5);
    const brownie = order.items.find((i) => i.itemNumber === "ZFUSA03-C");
    expect(brownie).toMatchObject({
      qty: 2,
      unitPrice: 48,
      lineTotal: 96,
      listPrice: 15,
    });
    expect(brownie?.upc).toBe("10628678860152");
  });

  it("carries a ship-caveat note through", () => {
    const brownie = order.items.find((i) => i.itemNumber === "ZFUSA03-C");
    expect(brownie?.notes).toBe("Only available to ship on September 1, 2026");
  });

  it("surfaces the order-level discount rather than applying it", () => {
    // Line totals sum to 684.00; order total is 615.60 -> a 68.40 discount.
    const lineSum = order.items.reduce((s, i) => s + i.lineTotal, 0);
    expect(lineSum).toBeCloseTo(684, 2);
    expect(order.warnings.some((w) => w.includes("order-level discount of 68.40"))).toBe(true);
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
