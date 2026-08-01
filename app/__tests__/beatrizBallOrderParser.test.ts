// /app/__tests__/beatrizBallOrderParser.test.ts
//
// The fixture is condensed from the real Beatriz Ball Sales Orders (SO 0063477
// net $226.00; SO 0063476 net $2,368.50). It keeps the shapes a naive parser
// gets wrong: the run-together item line whose item-code/amount boundary is
// ambiguous by shape ("3496"+"99.00" vs "34969"+"9.00"), a wrapped description,
// the repeated page header, and the free $0 placard line.

import { parseBeatrizBallOrderText } from "@/lib/pricing/beatrizBallOrderParser";

const FIXTURE = [
  "Sales Order",
  "DEPT AT 952426",
  "ATLANTA, GA  31192-2426",
  "PO # PON09066",
  "Order Number:",
  "Order Date:",
  "Customer Number:",
  "0063477",
  "6/10/2026",
  "0008169",
  "Item Code",
  "WholesaleAmountMSRP",
  "Item Description",
  "Ordered",
  "349699.0056.0024.754GLASS Vento Medium Vase (Clear)",
  // wrapped description: ends mid-phrase, continues on the next line
  "919282.0093.0041.002ENCANTO Claire Small Oval Bowl with Spoon (Bordeaux and ",
  "White)",
  // free $0 line — must reconcile at zero and be kept
  "66440.000.000.001Beatriz Ball metal placard",
  // net = 99.00 + 82.00 + 0.00 for the three fixture lines
  "Net Order:181.00",
  "Freight:0.00",
].join("\n");

describe("parseBeatrizBallOrderText", () => {
  const order = parseBeatrizBallOrderText(FIXTURE);

  it("pins the vendor and reads the customer PO / order number / net total", () => {
    expect(order.vendorName).toBe("Beatriz Ball");
    expect(order.customerPo).toBe("PON09066");
    expect(order.orderNumber).toBe("0063477");
    expect(order.orderDate).toBe("6/10/2026");
    expect(order.printedTotal).toBeCloseTo(181, 2);
  });

  it("splits the item-code / amount boundary using wholesale x qty == amount", () => {
    // "349699.0056.0024.754..." -> code 3496, amount 99.00, msrp 56.00,
    // wholesale 24.75, qty 4 (NOT code 34969, amount 9.00).
    const vase = order.items.find((i) => i.itemCode === "3496");
    expect(vase).toMatchObject({ qty: 4, unitPrice: 24.75, lineTotal: 99, msrp: 56 });
    expect(vase?.name).toBe("GLASS Vento Medium Vase (Clear)");
  });

  it("rejoins a description that wraps onto the next line", () => {
    const bowl = order.items.find((i) => i.itemCode === "9192");
    expect(bowl?.name).toBe("ENCANTO Claire Small Oval Bowl with Spoon (Bordeaux and White)");
    expect(bowl).toMatchObject({ qty: 2, unitPrice: 41, lineTotal: 82, msrp: 93 });
  });

  it("keeps a free $0 line and reconciles it at zero", () => {
    const placard = order.items.find((i) => i.itemCode === "6644");
    expect(placard).toMatchObject({ qty: 1, unitPrice: 0, lineTotal: 0, msrp: 0 });
    expect(placard?.name).toBe("Beatriz Ball metal placard");
  });

  it("reconciles the line amounts against the net order with no warnings", () => {
    expect(order.items).toHaveLength(3);
    expect(order.items.reduce((s, i) => s + i.lineTotal, 0)).toBeCloseTo(181, 2);
    expect(order.warnings).toEqual([]);
  });

  it("warns when the line amounts do not match the net order", () => {
    const bad = parseBeatrizBallOrderText(
      ["349699.0056.0024.754GLASS Vento Medium Vase (Clear)", "Net Order:999.00"].join("\n"),
    );
    expect(bad.warnings.some((w) => w.includes("does not match the net order"))).toBe(true);
  });
});
