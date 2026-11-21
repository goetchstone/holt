// /app/__tests__/simblistCsvOrderParser.test.ts
//
// The fixture is a real Simblist Group / Maison Zoe Ford export (PO number and every
// price invented -- this repo is public and a vendor's dealer costs are
// confidential). It keeps five items, the two-table shape (order-header pair +
// item table) and the order-level discount (line totals summing above the order
// total) that the parser must surface rather than silently apply.

import { parseSimblistCsvText } from "@/lib/pricing/simblistCsvOrderParser";

const FIXTURE = [
  "RepGroup,Manufacturer,PO #,Order Date,Request Date,Ship Date,Cancel Date,Order Total,Customer Name",
  "Simblist Group,MAISON ZOE FORD,PON00001,2026-01-05,2026-03-02,2026-03-02,,615.60,RIVERBEND HOME",
  "Sequence #,Item Number,Name,Description,Quantity,Unit Price,Unit Qty,Item Discount,UPC,Unit of measure,Size,Color,Style,Notes,Retailer Item Number,List Price,Item Status,Extended Price,Total Price",
  '3,ZFUSA03-C,Big Time Brownie Mix - case pack of 6,,2,48.00,,0.0,10628678860152,,,,,"Only available to ship on March 2, 2026",,15.00,,,$96.00',
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
    expect(order.shipDate).toBe("2026-03-02");
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
    expect(brownie?.notes).toBe("Only available to ship on March 2, 2026");
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

describe("parseSimblistCsvText: a cell it cannot read", () => {
  /** An order whose Order Total is `orderTotal`, with the given item rows. */
  const csv = (orderTotal: string, ...items: string[]) =>
    [
      "RepGroup,Manufacturer,PO #,Order Total",
      `Simblist,X Co,PON1,${orderTotal}`,
      "Item Number,Name,Quantity,Unit Price,UPC,Total Price,List Price",
      ...items,
    ].join("\n");
  const GOOD_LINE = "ZF08,Widget,2,36.00,124,$72.00,";

  // Until 2026-11-21 an unreadable price read as 0, and 0 x qty = 0 passed the
  // line check: the item was imported at $0, and nothing named it.
  it.each([
    ["a 400-digit run", "9".repeat(400)],
    ["Infinity", "Infinity"],
    ["1e999", "1e999"],
  ])("leaves out a line whose prices are %s, and names it", (_label, bad) => {
    // The order total equals the readable line, so no order-level warning fires.
    const order = parseSimblistCsvText(csv("72.00", `ZF07,Mix,2,${bad},123,${bad},`, GOOD_LINE));
    expect(order.items.map((i) => i.itemNumber)).toEqual(["ZF08"]);
    expect(order.warnings).toHaveLength(1);
    expect(order.warnings[0]).toMatch(/^Item ZF07: the Unit Price ".*" is not a number/);
    expect(order.warnings[0]).toContain("add it by hand");
  });

  it("names the line with a blank Order Total too, where nothing else would warn", () => {
    const order = parseSimblistCsvText(csv("", `ZF07,Mix,2,${"9".repeat(400)},123,Infinity,`));
    expect(order.items).toEqual([]);
    expect(order.warnings).toHaveLength(1);
    expect(order.warnings[0]).toMatch(/^Item ZF07: /);
    // The cell is quoted cut short, not 400 characters long.
    expect(order.warnings[0]).toContain(`"${"9".repeat(20)}…"`);
  });

  it("warns that an unreadable Order Total was not checked against the lines", () => {
    const order = parseSimblistCsvText(csv("1e999", GOOD_LINE));
    expect(order.items).toHaveLength(1);
    expect(order.printedTotal).toBe(0);
    expect(order.warnings).toEqual([
      'The Order Total "1e999" is not a number, so the line totals were not checked against it.',
    ]);
  });

  it("leaves out a Quantity that is not a whole number (1e999 used to read as 1)", () => {
    const order = parseSimblistCsvText(
      csv("", "ZF09,Mix,1e999,36.00,125,$36.00,", "ZF10,Mix,1.5,36.00,126,$54.00,"),
    );
    expect(order.items).toEqual([]);
    expect(order.warnings).toHaveLength(2);
    expect(order.warnings[0]).toMatch(/^Item ZF09: the Quantity "1e999" is not a number/);
    expect(order.warnings[1]).toMatch(/^Item ZF10: the Quantity "1\.5" is not a number/);
  });

  it("reads an unreadable List Price as null, not 0", () => {
    const order = parseSimblistCsvText(csv("", "ZF08,Widget,2,36.00,124,$72.00,1e999"));
    expect(order.items[0].listPrice).toBeNull();
    expect(order.warnings).toEqual([]);
  });

  it("still imports a line with blank prices at $0, with no warning (owner, 2026-11-21)", () => {
    const order = parseSimblistCsvText(csv("", "ZF11,Sample,2,,127,,"));
    expect(order.items).toMatchObject([{ itemNumber: "ZF11", qty: 2, unitPrice: 0, lineTotal: 0 }]);
    expect(order.warnings).toEqual([]);
  });
});
