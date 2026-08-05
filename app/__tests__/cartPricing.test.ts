// /app/__tests__/cartPricing.test.ts
//
// The money arithmetic. These tests exist because the POS and the server
// previously priced carts differently and nobody noticed: the customer was
// charged the client's figure while the database recorded the server's.
//
// The headline case is `charges and records the same number`, which is the
// property that was violated in production.

import {
  computeOrderDiscount,
  discountedUnitPrice,
  priceCart,
} from "@/lib/pos/cartPricing";

const CT_TAX = 0.0635;

describe("item discounts", () => {
  it("applies percent and amount discounts to the unit price", () => {
    expect(discountedUnitPrice(100, [{ type: "PERCENT", value: 10 }])).toBe(90);
    expect(discountedUnitPrice(100, [{ type: "AMOUNT", value: 15 }])).toBe(85);
  });

  it("stacks discounts sequentially, not additively", () => {
    // Two 10% discounts are 19% off, not 20%. This is how staff read a stacked
    // discount on a receipt, and changing it would silently reprice every sale.
    expect(discountedUnitPrice(100, [
      { type: "PERCENT", value: 10 },
      { type: "PERCENT", value: 10 },
    ])).toBe(81);
  });

  it("clamps at zero instead of going negative", () => {
    // A discount larger than the price makes the item free. Allowing a negative
    // unit price would turn a discount into a refund.
    expect(discountedUnitPrice(50, [{ type: "AMOUNT", value: 80 }])).toBe(0);
  });
});

describe("order discount", () => {
  it("resolves percent and amount against the subtotal", () => {
    expect(computeOrderDiscount({ type: "PERCENT", value: 10 }, 1000)).toBe(100);
    expect(computeOrderDiscount({ type: "AMOUNT", value: 250 }, 1000)).toBe(250);
  });

  it("never exceeds the subtotal or goes negative", () => {
    expect(computeOrderDiscount({ type: "AMOUNT", value: 5000 }, 1000)).toBe(1000);
    expect(computeOrderDiscount({ type: "AMOUNT", value: -50 }, 1000)).toBe(0);
    expect(computeOrderDiscount(null, 1000)).toBe(0);
  });
});

describe("priceCart", () => {
  it("charges and records the same number — the bug that motivated this module", () => {
    // $1,000 with $100 off at 6.35%. The old POS charged $900 (its own
    // subtotal minus discount, no tax) while the server recorded $1,063.50
    // (full price plus tax, no discount), leaving $163.50 outstanding forever.
    const priced = priceCart(
      [{ unitPrice: 1000, quantity: 1 }],
      { taxRate: CT_TAX, orderDiscount: { type: "AMOUNT", value: 100 } },
    );

    expect(priced.netSubtotal).toBe(900);
    expect(priced.taxAmount).toBe(57.15); // 900 * 0.0635 — on the DISCOUNTED amount
    expect(priced.total).toBe(957.15);

    // What lands in the database must add up to what the customer is charged.
    const recorded = priced.items.reduce((s, i) => s + i.netPrice + i.vatAmount, 0);
    expect(Math.round(recorded * 100) / 100).toBe(priced.total);
  });

  it("taxes the discounted amount, not the list price", () => {
    // Taxing pre-discount overcharges the customer AND overstates the tax
    // owed to the state.
    const priced = priceCart([{ unitPrice: 100, quantity: 1, discounts: [{ type: "PERCENT", value: 50 }] }], {
      taxRate: 0.1,
    });
    expect(priced.items[0].netPrice).toBe(50);
    expect(priced.items[0].vatAmount).toBe(5);
    expect(priced.total).toBe(55);
  });

  it("keeps netPrice as the LINE total, never the unit price", () => {
    // docs/domains/reporting.md invariant. Multiplying netPrice by quantity
    // downstream has inflated totals before.
    const priced = priceCart([{ unitPrice: 25, quantity: 4 }], { taxRate: 0 });
    expect(priced.items[0].netPrice).toBe(100);
  });

  it("allocates the order discount across lines so per-line tax is right", () => {
    const priced = priceCart(
      [
        { unitPrice: 300, quantity: 1 },
        { unitPrice: 100, quantity: 1 },
      ],
      { taxRate: 0.1, orderDiscount: { type: "AMOUNT", value: 40 } },
    );
    // 300/400 and 100/400 of the $40.
    expect(priced.items[0].orderDiscountShare).toBe(30);
    expect(priced.items[1].orderDiscountShare).toBe(10);
    expect(priced.items[0].netPrice).toBe(270);
    expect(priced.items[1].netPrice).toBe(90);
    expect(priced.total).toBe(396); // 360 + 36
  });

  it("allocates every cent, even when the split does not divide evenly", () => {
    // Three equal lines and $10: 3.33 + 3.33 + 3.34. If the remainder were
    // dropped, the line totals would not sum to the amount discounted and the
    // order would carry a one-cent balance nobody can pay.
    const priced = priceCart(
      [
        { unitPrice: 100, quantity: 1 },
        { unitPrice: 100, quantity: 1 },
        { unitPrice: 100, quantity: 1 },
      ],
      { taxRate: 0, orderDiscount: { type: "AMOUNT", value: 10 } },
    );
    const allocated = priced.items.reduce((s, i) => s + i.orderDiscountShare, 0);
    expect(Math.round(allocated * 100) / 100).toBe(10);
    expect(priced.total).toBe(290);
  });

  it("treats a return line as negative and excludes it from discount allocation", () => {
    // A return is money going back; giving it a share of a discount would
    // quietly reduce the refund.
    const priced = priceCart(
      [
        { unitPrice: 200, quantity: 1 },
        { unitPrice: 50, quantity: 1, isReturn: true },
      ],
      { taxRate: 0, orderDiscount: { type: "AMOUNT", value: 20 } },
    );
    expect(priced.items[1].lineSubtotal).toBe(-50);
    expect(priced.items[1].orderDiscountShare).toBe(0);
    expect(priced.items[0].orderDiscountShare).toBe(20);
    expect(priced.subtotal).toBe(150);
    expect(priced.total).toBe(130);
  });

  it("charges no tax when the rate is zero (exempt customer)", () => {
    const priced = priceCart([{ unitPrice: 1000, quantity: 1 }], { taxRate: 0 });
    expect(priced.taxAmount).toBe(0);
    expect(priced.total).toBe(1000);
  });

  it("handles an empty cart without producing NaN", () => {
    const priced = priceCart([], { taxRate: CT_TAX });
    expect(priced.total).toBe(0);
    expect(priced.subtotal).toBe(0);
    expect(priced.taxAmount).toBe(0);
  });
});
