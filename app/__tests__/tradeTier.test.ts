// /app/__tests__/tradeTier.test.ts
//
// GAP-06 part C: what a trade tier entitles a customer to on a line
// (lib/pricing/tradeTier.ts). The register, New Quote and the server's discount
// policy all price through this, so its edges are pinned here; that the server
// applies it on every writer is __tests__/integration/tradeTierPricing.integration.test.ts.

import {
  customerTradeTier,
  entitledUnitPrice,
  priceLineForTier,
  tradeLabel,
  tierPercentProblem,
  tradeTierPercent,
} from "@/lib/pricing/tradeTier";

const TIER = { discountPercent: 20, isActive: true };
const OFF = { tradeDiscountOnSaleItems: false };
const ON = { tradeDiscountOnSaleItems: true };

function entitled(overrides: Partial<Parameters<typeof entitledUnitPrice>[0]> = {}) {
  return entitledUnitPrice({
    effectiveRetail: 1000,
    onSale: false,
    tier: TIER,
    vendorAllows: true,
    settings: OFF,
    ...overrides,
  });
}

describe("entitledUnitPrice", () => {
  it("takes the tier's percent off the retail", () => {
    expect(entitled()).toEqual({ price: 800, tierPercent: 20, reason: "ENTITLED" });
  });

  it("rounds to the cent, half up, never by the store's charm rule", () => {
    // 33.33 x 0.85 = 28.3305 -> 28.33; 0.99 x 0.5 = 0.495 -> 0.50 (half up, not 0.49).
    expect(entitled({ effectiveRetail: 33.33, tier: { ...TIER, discountPercent: 15 } }).price).toBe(
      28.33,
    );
    expect(entitled({ effectiveRetail: 0.99, tier: { ...TIER, discountPercent: 50 } }).price).toBe(
      0.5,
    );
    expect(entitled({ effectiveRetail: 99.99 }).price).toBe(79.99);
  });

  it("reads a tier percent sent as Prisma's Decimal string", () => {
    expect(entitled({ tier: { discountPercent: "12.5", isActive: true } }).price).toBe(875);
  });

  it("gives nothing without a tier, or with one turned off", () => {
    expect(entitled({ tier: null })).toEqual({ price: 1000, tierPercent: null, reason: "NO_TIER" });
    expect(entitled({ tier: { ...TIER, isActive: false } })).toEqual({
      price: 1000,
      tierPercent: null,
      reason: "TIER_INACTIVE",
    });
  });

  it("gives nothing for a tier that takes nothing off or more than everything", () => {
    for (const discountPercent of [0, -5, 100.01, Number.NaN]) {
      expect(entitled({ tier: { discountPercent, isActive: true } }).reason).toBe(
        "TIER_NO_DISCOUNT",
      );
    }
    expect(entitled({ tier: { discountPercent: 100, isActive: true } }).price).toBe(0);
  });

  it("gives nothing where the vendor opts out", () => {
    expect(entitled({ vendorAllows: false })).toEqual({
      price: 1000,
      tierPercent: null,
      reason: "VENDOR_OPTED_OUT",
    });
  });

  it("leaves a sale price alone unless the store says a tier applies to it", () => {
    expect(entitled({ effectiveRetail: 600, onSale: true })).toEqual({
      price: 600,
      tierPercent: null,
      reason: "ON_SALE",
    });
    expect(entitled({ effectiveRetail: 600, onSale: true, settings: ON })).toEqual({
      price: 480,
      tierPercent: 20,
      reason: "ENTITLED",
    });
  });

  it("has nothing to discount on an item with no price", () => {
    expect(entitled({ effectiveRetail: null })).toEqual({
      price: null,
      tierPercent: null,
      reason: "NO_PRICE",
    });
    expect(entitled({ effectiveRetail: 0 }).reason).toBe("NO_PRICE");
  });
});

describe("customerTradeTier", () => {
  it("is the tier, as numbers, only while it is on and takes something off", () => {
    const tier = { id: 3, name: "Designer", discountPercent: "20.00", isActive: true };
    expect(customerTradeTier(tier)).toEqual({ id: 3, name: "Designer", discountPercent: 20 });
    expect(customerTradeTier({ ...tier, isActive: false })).toBeNull();
    expect(customerTradeTier({ ...tier, discountPercent: "0" })).toBeNull();
    expect(customerTradeTier(null)).toBeNull();
    expect(customerTradeTier(undefined)).toBeNull();
  });
});

describe("tradeTierPercent and tradeLabel", () => {
  it("reads a percent in range, and labels it", () => {
    expect(tradeTierPercent({ discountPercent: 25 })).toBe(25);
    expect(tradeTierPercent(null)).toBeNull();
    expect(tradeLabel(20)).toBe("Trade 20%");
    expect(tradeLabel(12.5)).toBe("Trade 12.5%");
  });

  it("rounds a percent to the hundredth a line records, so the price and the record agree", () => {
    // A third off: priced at 33.33, the percent the line's Decimal(5,2) keeps.
    expect(tradeTierPercent({ discountPercent: "33.333" })).toBe(33.33);
    expect(entitled({ tier: { ...TIER, discountPercent: "33.333" } })).toEqual({
      price: 666.7,
      tierPercent: 33.33,
      reason: "ENTITLED",
    });
    // Half a hundredth rounds up, as Postgres rounds it.
    expect(tradeTierPercent({ discountPercent: 12.125 })).toBe(12.13);
    // A percent that rounds to nothing takes nothing off (and so never records 0.00).
    expect(tradeTierPercent({ discountPercent: 0.004 })).toBeNull();
    expect(entitled({ tier: { ...TIER, discountPercent: 0.004 } }).reason).toBe("TIER_NO_DISCOUNT");
  });
});

describe("tierPercentProblem", () => {
  it("takes 0 to 100, to the hundredth, as a number or its text", () => {
    for (const ok of [0, 20, 12.5, 33.33, "15.25", 100]) expect(tierPercentProblem(ok)).toBeNull();
  });

  it("refuses more places than a line records, a value out of range, and a non-number", () => {
    expect(tierPercentProblem(33.333)).toBe("Discount can have at most two decimal places");
    expect(tierPercentProblem("0.004")).toBe("Discount can have at most two decimal places");
    expect(tierPercentProblem(-1)).toBe("Discount must be between 0 and 100");
    expect(tierPercentProblem(100.01)).toBe("Discount must be between 0 and 100");
    for (const bad of [null, undefined, "", "ten", true]) {
      expect(tierPercentProblem(bad)).toBe("Discount percent must be a number");
    }
  });
});

describe("priceLineForTier", () => {
  const DESIGNER = { id: 3, name: "Designer", discountPercent: 20 };
  const line = {
    retail: 1000,
    tradeEligible: true,
    priceTyped: false,
    isReturn: false,
    price: 1000,
    tradePercent: null as number | null,
  };

  it("prices an eligible line at the tier, and restores retail when the tier goes", () => {
    const traded = priceLineForTier(line, DESIGNER);
    expect(traded).toMatchObject({ price: 800, tradePercent: 20 });
    expect(priceLineForTier(traded, null)).toMatchObject({ price: 1000, tradePercent: null });
  });

  it("never moves a price someone typed", () => {
    const typed = { ...line, priceTyped: true, price: 650 };
    expect(priceLineForTier(typed, DESIGNER)).toBe(typed);
    expect(priceLineForTier(typed, null)).toBe(typed);
  });

  it("sells a return, or a product that can't take a tier, at its retail", () => {
    expect(priceLineForTier({ ...line, isReturn: true }, DESIGNER)).toMatchObject({
      price: 1000,
      tradePercent: null,
    });
    expect(priceLineForTier({ ...line, tradeEligible: false }, DESIGNER)).toMatchObject({
      price: 1000,
      tradePercent: null,
    });
  });

  it("leaves a sale price alone unless the store says a tier applies to it", () => {
    const onSale = { ...line, retail: 900, price: 900, onSale: true };
    expect(priceLineForTier(onSale, DESIGNER)).toMatchObject({ price: 900, tradePercent: null });
    expect(priceLineForTier(onSale, DESIGNER, { tradeDiscountOnSaleItems: true })).toMatchObject({
      price: 720,
      tradePercent: 20,
    });
  });
});
