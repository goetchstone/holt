// /app/__tests__/aestheticMovementOrderParser.test.ts
//
// The fixture is condensed from the real Aesthetic Movement order (Printworks,
// PON09056, 6 items, 66 units, $2,688.00). It keeps the two shapes a naive
// parser gets wrong: an item with an ETA/OOS status line between the name and
// the UPC (which must not become the name or a price), and an out-of-stock item
// that prints NO UPC (its barcode must come out blank, not steal the money).

import { parseAestheticMovementOrderText } from "@/lib/pricing/aestheticMovementOrderParser";

const FIXTURE = [
  "Vendor: Printworks",
  "Date: June 12, 2026",
  "PO: #PON09056",
  "Earliest Ship Date October 01, 2026",
  "SKUItemQuantityPriceTotal",
  "PW00689",
  "Classic - Tic Tac Toe NEW",
  "7350108174152",
  "12$33.00$396.00",
  "PW00682",
  "Classic - Backgammon NEW",
  "ETA EARLY JULY",
  "7350108174084",
  "12$38.00$456.00",
  "PW00821",
  "Reverra - Mahjong",
  "OOS - ETA EARLY SEPTEMBER",
  "6$126.00$756.00",
  "Number of Items: 3",
  "Total Quantity: 30",
  "Subtotal:$1608.00",
  "Discount:$0.00",
  "Order Total:$1608.00",
].join("\n");

describe("parseAestheticMovementOrderText", () => {
  const order = parseAestheticMovementOrderText(FIXTURE);

  it("reads the vendor from the document and the PO number", () => {
    expect(order.vendorName).toBe("Printworks");
    expect(order.poNumber).toBe("PON09056");
    expect(order.shipDate).toBe("October 01, 2026");
  });

  it("parses a plain item: name, UPC, then qty $price $total", () => {
    const item = order.items.find((i) => i.sku === "PW00689");
    expect(item).toMatchObject({
      name: "Classic - Tic Tac Toe NEW",
      upc: "7350108174152",
      qty: 12,
      unitPrice: 33,
      lineTotal: 396,
    });
  });

  it("ignores an ETA/status line between the name and the UPC", () => {
    // "ETA EARLY JULY" must not become the name or be mistaken for money.
    const item = order.items.find((i) => i.sku === "PW00682");
    expect(item?.name).toBe("Classic - Backgammon NEW");
    expect(item?.upc).toBe("7350108174084");
  });

  it("exports a blank barcode for an out-of-stock item that prints no UPC", () => {
    const oos = order.items.find((i) => i.sku === "PW00821");
    expect(oos).toMatchObject({ name: "Reverra - Mahjong", upc: "", qty: 6, unitPrice: 126 });
    expect(oos?.lineTotal).toBe(756);
  });

  it("reconciles item count, units, and the order total with no warnings", () => {
    expect(order.items).toHaveLength(3);
    expect(order.items.reduce((s, i) => s + i.qty, 0)).toBe(30);
    expect(order.items.reduce((s, i) => s + i.lineTotal, 0)).toBeCloseTo(1608, 2);
    expect(order.warnings).toEqual([]);
  });

  it("warns when qty x price does not equal the line total", () => {
    const bad = parseAestheticMovementOrderText(
      ["Vendor: X", "PO: #PON1", "PW1", "Widget", "2$10.00$999.00"].join("\n"),
    );
    expect(bad.warnings.some((w) => w.includes("does not equal the line total"))).toBe(true);
  });

  it("warns when the read total does not match the order total", () => {
    const bad = parseAestheticMovementOrderText(
      ["Vendor: X", "PO: #PON1", "PW1", "Widget", "2$10.00$20.00", "Order Total:$999.00"].join(
        "\n",
      ),
    );
    expect(bad.warnings.some((w) => w.includes("does not match the order total"))).toBe(true);
  });
});
