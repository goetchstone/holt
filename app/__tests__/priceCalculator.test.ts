// /app/__tests__/priceCalculator.test.ts

import {
  calculatePrice,
  calculateWoodPrice,
  calculateFramePlusCushionPrice,
  ProductWithPricing,
  WoodProductWithPricing,
  AvailableOption,
  GradePrice,
} from "../src/lib/pricing/priceCalculator";

// ─── Test fixtures ──────────────────────────────────────────────

function makeGradePrice(overrides: Partial<GradePrice> = {}): GradePrice {
  return {
    tierId: 1,
    tierCode: "14",
    tierName: "Grade 14",
    cost: 1000,
    retail: null,
    extrapolated: false,
    fabricCount: 0,
    ...overrides,
  };
}

function makeOption(overrides: Partial<AvailableOption> = {}): AvailableOption {
  return {
    optionId: 100,
    groupName: "Trim",
    optionName: "Nailhead",
    surcharge: 50,
    surchargeType: "FLAT",
    isStandard: false,
    isAvailable: true,
    requiresTextInput: false,
    textInputLabel: null,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<ProductWithPricing> = {}): ProductWithPricing {
  return {
    id: 1,
    productNumber: "1952",
    name: "Hartwell Sofa",
    description: null,
    baseCost: 800,
    baseRetail: null,
    mapPrice: null,
    comYardage: 12,
    comYardagePattern: 14,
    comYardageRepeat: null,
    gradeRiser: 25,
    standardSeat: null,
    standardBack: null,
    standardPillows: null,
    finish: null,
    width: 86,
    depth: 38,
    height: 36,
    seatHeight: 20,
    armHeight: 25,
    seatDepth: 22,
    imageUrl: null,
    collection: null,
    gradePrices: [makeGradePrice()],
    availableOptions: [],
    ...overrides,
  };
}

function makeWoodProduct(overrides: Partial<WoodProductWithPricing> = {}): WoodProductWithPricing {
  return {
    id: 2,
    productNumber: "48-6030",
    name: "Canterbury Table",
    description: null,
    baseCost: 500,
    baseRetail: null,
    mapPrice: null,
    imageUrl: null,
    speciesPrices: [],
    axisPrices: [],
    availableOptions: [],
    ...overrides,
  };
}

// ─── calculatePrice ─────────────────────────────────────────────

describe("calculatePrice", () => {
  it("computes basic grade-based pricing with default 2.5x markup", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set());

    expect(result.basePrice).toBe(1000);
    expect(result.totalCost).toBe(1000);
    expect(result.suggestedRetail).toBe(2500);
    expect(result.asShownPrice).toBe(2500);
    expect(result.margin).toBe(1500);
    expect(result.marginPercent).toBe(0.6);
    expect(result.gradeName).toBe("Grade 14");
  });

  it("falls back to baseCost when selected tier is not found", () => {
    const product = makeProduct({
      baseCost: 800,
      gradePrices: [makeGradePrice({ tierId: 1 })],
    });
    const result = calculatePrice(product, 999, new Set());

    expect(result.basePrice).toBe(800);
    expect(result.gradeName).toBe("Base");
  });

  it("uses 0 when neither grade nor baseCost exists", () => {
    const product = makeProduct({
      baseCost: null,
      gradePrices: [],
    });
    const result = calculatePrice(product, 999, new Set());

    expect(result.basePrice).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.suggestedRetail).toBe(0);
  });

  it("uses stored retail for retail-first vendors", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 600, retail: 1500 })],
    });
    const result = calculatePrice(product, 1, new Set());

    expect(result.basePrice).toBe(600);
    expect(result.totalCost).toBe(600);
    // Stored retail used instead of cost * markup
    expect(result.suggestedRetail).toBe(1500);
    expect(result.margin).toBe(900);
  });

  it("adds stored retail + options*markup for retail-first vendors with options", () => {
    const option = makeOption({ optionId: 10, surcharge: 100, surchargeType: "FLAT" });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 600, retail: 1500 })],
      availableOptions: [option],
    });
    const result = calculatePrice(product, 1, new Set([10]));

    // storedRetail + subtotalOptions * retailMarkup = 1500 + 100 * 2.5 = 1750
    expect(result.suggestedRetail).toBe(1750);
    expect(result.totalCost).toBe(700); // 600 + 100
  });

  it("adds FLAT surcharge to cost", () => {
    const option = makeOption({ optionId: 10, surcharge: 200, surchargeType: "FLAT" });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
      availableOptions: [option],
    });
    const result = calculatePrice(product, 1, new Set([10]));

    expect(result.optionLines).toHaveLength(1);
    expect(result.optionLines[0].amount).toBe(200);
    expect(result.subtotalOptions).toBe(200);
    expect(result.totalCost).toBe(1200);
  });

  it("adds PERCENTAGE surcharge based on basePrice", () => {
    const option = makeOption({ optionId: 10, surcharge: 0.1, surchargeType: "PERCENTAGE" });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
      availableOptions: [option],
    });
    const result = calculatePrice(product, 1, new Set([10]));

    expect(result.optionLines[0].amount).toBe(100); // 1000 * 0.1
    expect(result.totalCost).toBe(1100);
  });

  it("treats PER_UNIT same as FLAT", () => {
    const option = makeOption({ optionId: 10, surcharge: 75, surchargeType: "PER_UNIT" });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
      availableOptions: [option],
    });
    const result = calculatePrice(product, 1, new Set([10]));

    expect(result.optionLines[0].amount).toBe(75);
    expect(result.totalCost).toBe(1075);
  });

  it("sums multiple selected options", () => {
    const opt1 = makeOption({ optionId: 10, surcharge: 100, surchargeType: "FLAT" });
    const opt2 = makeOption({
      optionId: 11,
      groupName: "Fill",
      optionName: "Spring Down",
      surcharge: 150,
      surchargeType: "FLAT",
    });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
      availableOptions: [opt1, opt2],
    });
    const result = calculatePrice(product, 1, new Set([10, 11]));

    expect(result.optionLines).toHaveLength(2);
    expect(result.subtotalOptions).toBe(250);
    expect(result.totalCost).toBe(1250);
  });

  it("skips standard options (no surcharge)", () => {
    const option = makeOption({ optionId: 10, surcharge: 100, isStandard: true });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
      availableOptions: [option],
    });
    const result = calculatePrice(product, 1, new Set([10]));

    expect(result.optionLines).toHaveLength(0);
    expect(result.totalCost).toBe(1000);
  });

  it("skips unavailable options", () => {
    const option = makeOption({ optionId: 10, surcharge: 100, isAvailable: false });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
      availableOptions: [option],
    });
    const result = calculatePrice(product, 1, new Set([10]));

    expect(result.optionLines).toHaveLength(0);
    expect(result.totalCost).toBe(1000);
  });

  it("skips options not in selectedOptionIds", () => {
    const option = makeOption({ optionId: 10, surcharge: 100 });
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
      availableOptions: [option],
    });
    const result = calculatePrice(product, 1, new Set([999]));

    expect(result.optionLines).toHaveLength(0);
    expect(result.totalCost).toBe(1000);
  });

  it("applies 20% discount off suggested retail", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set(), 2.5, 0.2);

    expect(result.suggestedRetail).toBe(2500);
    expect(result.discountPercent).toBe(0.2);
    expect(result.discountAmount).toBe(500);
    expect(result.asShownPrice).toBe(2000);
  });

  it("clamps negative discount to 0", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set(), 2.5, -0.5);

    expect(result.discountPercent).toBe(0);
    expect(result.discountAmount).toBe(0);
    expect(result.asShownPrice).toBe(2500);
  });

  it("clamps discount above 1 to 1", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set(), 2.5, 1.5);

    expect(result.discountPercent).toBe(1);
    expect(result.asShownPrice).toBe(0);
  });

  it("warns when MAP is enforced and price is below MAP", () => {
    const product = makeProduct({
      mapPrice: 2200,
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    // asShownPrice = 2000 (2500 - 20% discount), below MAP of 2200
    const result = calculatePrice(product, 1, new Set(), 2.5, 0.2, true);

    expect(result.mapWarning).toBe(true);
    expect(result.mapPrice).toBe(2200);
  });

  it("does not warn when MAP enforced but price is above MAP", () => {
    const product = makeProduct({
      mapPrice: 2000,
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    // asShownPrice = 2500 (no discount), above MAP of 2000
    const result = calculatePrice(product, 1, new Set(), 2.5, 0, true);

    expect(result.mapWarning).toBe(false);
  });

  it("does not warn when MAP is not enforced", () => {
    const product = makeProduct({
      mapPrice: 5000,
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set(), 2.5, 0, false);

    expect(result.mapWarning).toBe(false);
  });

  it("handles zero asShownPrice without NaN margin", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    // 100% discount -> asShownPrice = 0
    const result = calculatePrice(product, 1, new Set(), 2.5, 1.0);

    expect(result.asShownPrice).toBe(0);
    expect(result.marginPercent).toBe(0);
    expect(Number.isNaN(result.marginPercent)).toBe(false);
  });

  it("uses custom markup multiplier", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set(), 3.0);

    expect(result.suggestedRetail).toBe(3000);
  });

  it("passes through COM yardage and gradeRiser from product", () => {
    const product = makeProduct({
      comYardage: 12,
      comYardagePattern: 14,
      comYardageRepeat: 27,
      gradeRiser: 25,
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set());

    expect(result.comYardage).toBe(12);
    expect(result.comYardagePattern).toBe(14);
    expect(result.comYardageRepeat).toBe(27);
    expect(result.gradeRiser).toBe(25);
  });

  it("sets estimatedRetail as alias for suggestedRetail", () => {
    const product = makeProduct({
      gradePrices: [makeGradePrice({ tierId: 1, cost: 1000 })],
    });
    const result = calculatePrice(product, 1, new Set());

    expect(result.estimatedRetail).toBe(result.suggestedRetail);
  });
});

// ─── calculateWoodPrice ─────────────────────────────────────────

describe("calculateWoodPrice", () => {
  it("looks up price by species tier", () => {
    const product = makeWoodProduct({
      speciesPrices: [
        { tierId: 10, tierCode: "CHERRY", tierName: "Cherry", cost: 1200 },
        { tierId: 11, tierCode: "MAPLE", tierName: "Maple", cost: 1000 },
      ],
    });
    const result = calculateWoodPrice(product, 10, new Set());

    expect(result.basePrice).toBe(1200);
    expect(result.gradeName).toBe("Cherry");
    expect(result.suggestedRetail).toBe(3000); // 1200 * 2.5
  });

  it("falls back to baseCost when species tier not found", () => {
    const product = makeWoodProduct({
      baseCost: 500,
      speciesPrices: [{ tierId: 10, tierCode: "CHERRY", tierName: "Cherry", cost: 1200 }],
    });
    const result = calculateWoodPrice(product, 999, new Set());

    expect(result.basePrice).toBe(500);
    expect(result.gradeName).toBe("Species");
  });

  it("looks up multi-axis price (species + width + length)", () => {
    const product = makeWoodProduct({
      axisPrices: [
        {
          tier1Id: 10,
          tier1: { id: 10, code: "CHERRY", name: "Cherry" },
          tier2Id: 20,
          tier2: { id: 20, code: "36", name: '36"' },
          tier3Id: 30,
          tier3: { id: 30, code: "48", name: '48"' },
          cost: 1800,
        },
      ],
    });
    const result = calculateWoodPrice(product, 10, new Set(), 2.5, 0, false, 20, 30);

    expect(result.basePrice).toBe(1800);
    expect(result.gradeName).toBe('Cherry \u00d7 36" \u00d7 48"');
  });

  it("looks up round table price (species + diameter, no length)", () => {
    const product = makeWoodProduct({
      axisPrices: [
        {
          tier1Id: 10,
          tier1: { id: 10, code: "WALNUT", name: "Walnut" },
          tier2Id: 20,
          tier2: { id: 20, code: "42", name: '42"' },
          tier3Id: 31,
          tier3: { id: 31, code: "N_A", name: "N/A" },
          cost: 2200,
        },
      ],
    });
    // No selectedLengthTierId for round tables
    const result = calculateWoodPrice(product, 10, new Set(), 2.5, 0, false, 20);

    expect(result.basePrice).toBe(2200);
    // N_A tier excluded from grade name
    expect(result.gradeName).toBe('Walnut \u00d7 42"');
  });

  it("falls back to baseCost when no species or axis prices exist", () => {
    const product = makeWoodProduct({ baseCost: 500 });
    const result = calculateWoodPrice(product, 1, new Set());

    expect(result.basePrice).toBe(500);
  });

  it("returns 0 when no pricing data and no baseCost", () => {
    const product = makeWoodProduct({ baseCost: null });
    const result = calculateWoodPrice(product, 1, new Set());

    expect(result.basePrice).toBe(0);
  });

  it("applies FLAT option surcharge", () => {
    const option = makeOption({ optionId: 10, surcharge: 150, surchargeType: "FLAT" });
    const product = makeWoodProduct({
      speciesPrices: [{ tierId: 10, tierCode: "CHERRY", tierName: "Cherry", cost: 1000 }],
      availableOptions: [option],
    });
    const result = calculateWoodPrice(product, 10, new Set([10]));

    expect(result.totalCost).toBe(1150);
    expect(result.optionLines).toHaveLength(1);
  });

  it("applies discount and computes margin", () => {
    const product = makeWoodProduct({
      speciesPrices: [{ tierId: 10, tierCode: "CHERRY", tierName: "Cherry", cost: 1000 }],
    });
    const result = calculateWoodPrice(product, 10, new Set(), 2.5, 0.2);

    expect(result.suggestedRetail).toBe(2500);
    expect(result.discountAmount).toBe(500);
    expect(result.asShownPrice).toBe(2000);
    expect(result.margin).toBe(1000); // 2000 - 1000
  });

  it("enforces MAP warning", () => {
    const product = makeWoodProduct({
      mapPrice: 2200,
      speciesPrices: [{ tierId: 10, tierCode: "CHERRY", tierName: "Cherry", cost: 1000 }],
    });
    const result = calculateWoodPrice(product, 10, new Set(), 2.5, 0.2, true);

    // asShownPrice = 2000, MAP = 2200
    expect(result.mapWarning).toBe(true);
  });

  it("always returns null for COM yardage fields", () => {
    const product = makeWoodProduct({
      speciesPrices: [{ tierId: 10, tierCode: "CHERRY", tierName: "Cherry", cost: 1000 }],
    });
    const result = calculateWoodPrice(product, 10, new Set());

    expect(result.comYardage).toBeNull();
    expect(result.comYardagePattern).toBeNull();
    expect(result.comYardageRepeat).toBeNull();
    expect(result.gradeRiser).toBeNull();
  });

  it("always computes retail as cost * markup (no stored retail branch)", () => {
    const product = makeWoodProduct({
      speciesPrices: [{ tierId: 10, tierCode: "CHERRY", tierName: "Cherry", cost: 1000 }],
    });
    const result = calculateWoodPrice(product, 10, new Set(), 3.0);

    expect(result.suggestedRetail).toBe(3000); // 1000 * 3.0
  });
});

// ─── calculateFramePlusCushionPrice ─────────────────────────────

describe("calculateFramePlusCushionPrice", () => {
  it("computes total retail as frame + cushion", () => {
    const result = calculateFramePlusCushionPrice(500, 200, []);

    expect(result.framePrice).toBe(500);
    expect(result.cushionPrice).toBe(200);
    expect(result.totalRetail).toBe(700);
    expect(result.gradeName).toBe("Selected Grade");
  });

  it("handles null cushion (frame only)", () => {
    const result = calculateFramePlusCushionPrice(500, null, []);

    expect(result.cushionPrice).toBe(0);
    expect(result.totalRetail).toBe(500);
    expect(result.gradeName).toBe("Frame Only");
  });

  it("adds FLAT option surcharge", () => {
    const options = [{ label: "Sunbrella Upgrade", surchargeType: "FLAT", surcharge: 75 }];
    const result = calculateFramePlusCushionPrice(500, 200, options);

    expect(result.optionLines).toHaveLength(1);
    expect(result.optionLines[0].amount).toBe(75);
    expect(result.subtotalOptions).toBe(75);
    expect(result.totalRetail).toBe(775); // 500 + 200 + 75
  });

  it("applies PERCENTAGE surcharge using cushionBaseForSurcharges", () => {
    const options = [{ label: "Trim", surchargeType: "PERCENTAGE", surcharge: 0.1 }];
    // cushionPrice=200, but surchargeBase override=300
    const result = calculateFramePlusCushionPrice(500, 200, options, 300);

    expect(result.optionLines[0].amount).toBe(30); // 300 * 0.1
  });

  it("falls back to cushionPrice for PERCENTAGE when no surchargeBase override", () => {
    const options = [{ label: "Trim", surchargeType: "PERCENTAGE", surcharge: 0.1 }];
    const result = calculateFramePlusCushionPrice(500, 200, options);

    expect(result.optionLines[0].amount).toBe(20); // 200 * 0.1
  });

  it("computes cost and margin with costMultiplier", () => {
    const result = calculateFramePlusCushionPrice(500, 200, [], undefined, 0.4);

    expect(result.frameCost).toBe(200); // 500 * 0.4
    expect(result.cushionCost).toBe(80); // 200 * 0.4
    expect(result.totalCost).toBe(280); // 700 * 0.4
    expect(result.margin).toBe(420); // 700 - 280
    expect(result.marginPercent).toBe(0.6); // 420 / 700
  });

  it("returns null cost/margin fields without costMultiplier", () => {
    const result = calculateFramePlusCushionPrice(500, 200, []);

    expect(result.frameCost).toBeNull();
    expect(result.cushionCost).toBeNull();
    expect(result.totalCost).toBeNull();
    expect(result.margin).toBeNull();
    expect(result.marginPercent).toBeNull();
  });

  it("excludes zero-amount options from optionLines", () => {
    const options = [{ label: "Free Upgrade", surchargeType: "FLAT", surcharge: 0 }];
    const result = calculateFramePlusCushionPrice(500, 200, options);

    expect(result.optionLines).toHaveLength(0);
  });

  it("handles zero totalRetail with costMultiplier without NaN", () => {
    const result = calculateFramePlusCushionPrice(0, null, [], undefined, 0.4);

    expect(result.totalRetail).toBe(0);
    expect(result.marginPercent).toBe(0);
    expect(Number.isNaN(result.marginPercent!)).toBe(false);
  });
});
