// /app/__tests__/beatrizBallOrderParser.test.ts
//
// The fixture's LAYOUT is condensed from two real Beatriz Ball Sales Orders;
// the order numbers, totals and every price are invented. This repo is public
// and a vendor's wholesale prices are confidential. It keeps the shapes a naive parser
// gets wrong: the run-together item line whose item-code/amount boundary is
// ambiguous by shape ("3496"+"72.00" vs "34967"+"2.00"), a wrapped description,
// the repeated page header, and the free $0 placard line.

import { parseBeatrizBallOrderText } from "@/lib/pricing/beatrizBallOrderParser";

const FIXTURE = [
  "Sales Order",
  "DEPT AT 952426",
  "ATLANTA, GA  31192-2426",
  "PO # PON00002",
  "Order Number:",
  "Order Date:",
  "Customer Number:",
  "0090001",
  "6/10/2026",
  "0090002",
  "Item Code",
  "WholesaleAmountMSRP",
  "Item Description",
  "Ordered",
  "349672.0045.0018.004GLASS Vento Medium Vase (Clear)",
  // wrapped description: ends mid-phrase, continues on the next line
  "919260.0075.0030.002ENCANTO Claire Small Oval Bowl with Spoon (Bordeaux and ",
  "White)",
  // free $0 line — must reconcile at zero and be kept
  "66440.000.000.001Beatriz Ball metal placard",
  // net = 99.00 + 82.00 + 0.00 for the three fixture lines
  "Net Order:132.00",
  "Freight:0.00",
].join("\n");

describe("parseBeatrizBallOrderText", () => {
  const order = parseBeatrizBallOrderText(FIXTURE);

  it("pins the vendor and reads the customer PO / order number / net total", () => {
    expect(order.vendorName).toBe("Beatriz Ball");
    expect(order.customerPo).toBe("PON00002");
    expect(order.orderNumber).toBe("0090001");
    expect(order.orderDate).toBe("6/10/2026");
    expect(order.printedTotal).toBeCloseTo(132, 2);
  });

  it("splits the item-code / amount boundary using wholesale x qty == amount", () => {
    // "349699.0056.0024.754..." -> code 3496, amount 99.00, msrp 56.00,
    // wholesale 24.75, qty 4 (NOT code 34969, amount 9.00).
    const vase = order.items.find((i) => i.itemCode === "3496");
    expect(vase).toMatchObject({ qty: 4, unitPrice: 18, lineTotal: 72, msrp: 45 });
    expect(vase?.name).toBe("GLASS Vento Medium Vase (Clear)");
  });

  it("rejoins a description that wraps onto the next line", () => {
    const bowl = order.items.find((i) => i.itemCode === "9192");
    expect(bowl?.name).toBe("ENCANTO Claire Small Oval Bowl with Spoon (Bordeaux and White)");
    expect(bowl).toMatchObject({ qty: 2, unitPrice: 30, lineTotal: 60, msrp: 75 });
  });

  it("keeps a free $0 line and reconciles it at zero", () => {
    const placard = order.items.find((i) => i.itemCode === "6644");
    expect(placard).toMatchObject({ qty: 1, unitPrice: 0, lineTotal: 0, msrp: 0 });
    expect(placard?.name).toBe("Beatriz Ball metal placard");
  });

  it("reconciles the line amounts against the net order with no warnings", () => {
    expect(order.items).toHaveLength(3);
    expect(order.items.reduce((s, i) => s + i.lineTotal, 0)).toBeCloseTo(132, 2);
    expect(order.warnings).toEqual([]);
  });

  it("warns when the line amounts do not match the net order", () => {
    const bad = parseBeatrizBallOrderText(
      ["349672.0045.0018.004GLASS Vento Medium Vase (Clear)", "Net Order:999.00"].join("\n"),
    );
    expect(bad.warnings.some((w) => w.includes("does not match the net order"))).toBe(true);
  });
});
