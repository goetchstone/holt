// /app/__tests__/lib/purchasing/landedCostShared.test.ts
//
// GAP-02: landed cost arithmetic -- splitting a charge across a PO's lines,
// the running average a receipt moves, and the cost a sale or a count reads.

import {
  addToAverage,
  allocateCharge,
  countUnitValue,
  landedUnitCost,
  parseCharge,
  perUnitCharges,
  productCost,
  removeFromAverage,
  saleUnitCost,
  spreadOverStock,
  unitVolume,
  type ChargeLine,
} from "@/lib/purchasing/landedCostShared";

const sofa: ChargeLine = { id: 1, quantity: 2, unitCost: 800, volume: 60, label: "Ashby Sofa" };
const chair: ChargeLine = { id: 2, quantity: 4, unitCost: 400, volume: 15, label: "Ashby Chair" };
const shares = (r: ReturnType<typeof allocateCharge>) =>
  r.ok ? Object.fromEntries(r.shares) : r.problem;

describe("allocateCharge", () => {
  it("splits by value: each line its share of what the shipment cost", () => {
    // 2 x 800 = 1600 and 4 x 400 = 1600: half each.
    expect(shares(allocateCharge(600, [sofa, chair], "VALUE"))).toEqual({ 1: 300, 2: 300 });
  });

  it("splits by quantity: each unit an equal share", () => {
    expect(shares(allocateCharge(600, [sofa, chair], "QUANTITY"))).toEqual({ 1: 200, 2: 400 });
  });

  it("splits by cubic volume: the space each line fills", () => {
    // 2 x 60 = 120 and 4 x 15 = 60: two thirds and one third.
    expect(shares(allocateCharge(600, [sofa, chair], "VOLUME"))).toEqual({ 1: 400, 2: 200 });
  });

  it("hands out the rounding cents so the shares add up to the charge exactly", () => {
    const three = [1, 2, 3].map((id) => ({ ...chair, id, quantity: 1 }));
    const r = allocateCharge(100, three, "QUANTITY");
    expect(r.ok && [...r.shares.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(shares(r)).toEqual({ 1: 33.34, 2: 33.33, 3: 33.33 });
  });

  it("gives a cancelled (zero-quantity) line no share (rule 31)", () => {
    expect(shares(allocateCharge(90, [sofa, { ...chair, quantity: 0 }], "QUANTITY"))).toEqual({
      1: 90,
    });
  });

  it("refuses a volume split when a line has no dimensions, naming it", () => {
    expect(shares(allocateCharge(90, [sofa, { ...chair, volume: null }], "VOLUME"))).toBe(
      "Ashby Chair has no dimensions: add them on the product, or split this charge another way.",
    );
  });

  it("refuses a split with nothing to weigh", () => {
    expect(shares(allocateCharge(90, [{ ...sofa, unitCost: 0 }], "VALUE"))).toBe(
      "The lines have no cost to split this by value; split it by quantity instead.",
    );
    expect(shares(allocateCharge(90, [], "QUANTITY"))).toBe(
      "This PO has no lines to spread a charge over.",
    );
  });
});

describe("perUnitCharges", () => {
  it("adds every charge's share per unit", () => {
    const perUnit = perUnitCharges(
      [
        { amount: 600, splitBy: "VALUE" },
        { amount: 120, splitBy: "QUANTITY" },
      ],
      [sofa, chair],
    );
    // Sofa: 300/2 + 40/2 = 170 a unit; chair: 300/4 + 80/4 = 95 a unit.
    expect(Object.fromEntries(perUnit)).toEqual({ 1: 170, 2: 95 });
  });

  it("spreads a volume charge by value once a line has lost its dimensions, never holding up a receipt", () => {
    const perUnit = perUnitCharges(
      [{ amount: 600, splitBy: "VOLUME" }],
      [sofa, { ...chair, volume: null }],
    );
    expect(Object.fromEntries(perUnit)).toEqual({ 1: 150, 2: 75 });
  });

  it("gives a line its unit cost plus its charges", () => {
    expect(landedUnitCost(800, 170)).toBe(970);
  });
});

describe("the running average", () => {
  it("weighs what was on hand at the old average against what arrived", () => {
    expect(addToAverage({ onHand: 2, average: 400, quantity: 4, unitCost: 475 })).toBe(450);
  });

  it("starts at the receipt's cost when there is no average yet", () => {
    expect(addToAverage({ onHand: 3, average: null, quantity: 2, unitCost: 950 })).toBe(950);
  });

  it("counts oversold stock (below zero) as none", () => {
    expect(addToAverage({ onHand: -3, average: 400, quantity: 2, unitCost: 500 })).toBe(500);
  });

  it("takes a receipt back out at the cost it came in at", () => {
    // 6 at 450, made of 2 at 400 and 4 at 475: without the 4, 400 again.
    expect(removeFromAverage({ onHand: 6, average: 450, quantity: 4, unitCost: 475 })).toBe(400);
  });

  it("leaves the average when nothing would be left, or the arithmetic would go below zero", () => {
    expect(removeFromAverage({ onHand: 4, average: 475, quantity: 4, unitCost: 475 })).toBe(475);
    expect(removeFromAverage({ onHand: 3, average: 100, quantity: 2, unitCost: 900 })).toBe(100);
  });

  it("lands a later charge on what is on hand, or reports it could not", () => {
    expect(spreadOverStock({ onHand: 4, average: 475, delta: 80 })).toEqual({
      average: 495,
      absorbed: true,
    });
    expect(spreadOverStock({ onHand: 0, average: 475, delta: 80 })).toEqual({
      average: 475,
      absorbed: false,
    });
  });
});

describe("the cost stock and sales read", () => {
  it("is the landed cost once there is one, else the catalog cost", () => {
    expect(productCost({ landedCost: "950", baseCost: "800" })).toBe(950);
    expect(productCost({ landedCost: null, baseCost: "800" })).toBe(800);
    expect(productCost({ landedCost: null, baseCost: null })).toBeNull();
  });

  it("prices a catalog product's sale at its own cost, whatever the screen sent", () => {
    expect(saleUnitCost({ landedCost: 950, baseCost: 800 }, 1)).toBe(950);
    // A configured or custom line has no catalog product: the configurator's cost.
    expect(saleUnitCost(null, 612.5)).toBe(612.5);
    expect(saleUnitCost(undefined, null)).toBe(0);
  });

  it("values a counted unit at its cost, else half its retail", () => {
    expect(countUnitValue({ landedCost: 950, baseCost: 800, baseRetail: 2000 })).toBe(950);
    expect(countUnitValue({ landedCost: null, baseCost: null, baseRetail: 2000 })).toBe(1000);
  });

  it("measures a unit in cubic feet: its own, else inches over 1,728", () => {
    expect(unitVolume({ cubicFeet: 42, width: 1, depth: 1, height: 1 })).toBe(42);
    expect(unitVolume({ width: 24, depth: 36, height: 12 })).toBe(6);
    expect(unitVolume({ length: 24, depth: 36, height: 12 })).toBe(6);
    expect(unitVolume({ width: 24, depth: 36 })).toBeNull();
  });
});

describe("parseCharge", () => {
  it("reads a charge, rounding to the cent and taking the store's split by default", () => {
    expect(parseCharge({ description: " Freight ", amount: 120.456 }, "VALUE")).toEqual({
      ok: true,
      value: { description: "Freight", amount: 120.46, splitBy: "VALUE" },
    });
    expect(
      parseCharge({ description: "Duty", amount: 40, splitBy: "VOLUME" }, "VALUE"),
    ).toMatchObject({
      ok: true,
      value: { splitBy: "VOLUME" },
    });
  });

  it.each([
    [{ amount: 10 }, "Say what the charge is for: freight, duty, crating."],
    [
      { description: "x".repeat(201), amount: 10 },
      "A charge's description can be at most 200 characters.",
    ],
    [{ description: "Freight", amount: 0 }, "The charge must be an amount more than 0."],
    [{ description: "Freight", amount: -5 }, "The charge must be an amount more than 0."],
    [{ description: "Freight", amount: "10" }, "The charge must be an amount more than 0."],
    [
      { description: "Freight", amount: 10, splitBy: "WEIGHT" },
      "A charge is split by value, by quantity or by cubic volume.",
    ],
  ])("refuses %j", (body, problem) => {
    expect(parseCharge(body, "VALUE")).toEqual({ ok: false, problem });
  });
});
