// /app/__tests__/fuzz/cartPricing.fuzz.test.ts
//
// Property-based fuzzing of lib/pos/cartPricing.ts -- the one place an order's
// price is decided (the server prices every POS order with it). Example tests
// pin a handful of carts; these properties hold for every cart, so they catch
// the rounding cases nobody thought to write down.
//
// Found a real bug on its first run: the order discount was split by rounding
// each line's proportional share independently and giving the last line the
// remainder. When the rounded shares overshoot, the remainder is NEGATIVE
// (documented "never negative"), and when they undershoot it can exceed the
// last line's value, giving a sale line a negative netPrice. Counterexamples:
// six $1.00 lines with $0.09 off -> shares [.02,.02,.02,.02,.02,-.01]; ten
// $1.00 lines + one $0.01 line with $0.15 off -> the $0.01 line nets -$0.04.

import fc from "fast-check";
import {
  computeOrderDiscount,
  discountedUnitPrice,
  priceCart,
  type CartDiscount,
  type PricedCartItemInput,
} from "@/lib/pos/cartPricing";

// `|| 0` folds -0 into 0: a -$0.00 tax line (a return taxed at a rate that
// rounds to nothing) is zero money, and toBe() would otherwise tell them apart.
const cents = (n: number): number => Math.round(n * 100) || 0;
const sumCents = (xs: number[]): number => xs.reduce((s, x) => s + cents(x), 0);

const money = (maxCents: number) => fc.integer({ min: 0, max: maxCents }).map((c) => c / 100);

const discount: fc.Arbitrary<CartDiscount> = fc.oneof(
  fc.record({
    type: fc.constant("PERCENT" as const),
    value: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.double({ min: 0, max: 100, noNaN: true })),
  }),
  fc.record({ type: fc.constant("AMOUNT" as const), value: money(50_000) }),
);

// Quantities are fractional (fabric is sold to the eighth of a yard), so
// eighths are generated alongside whole units.
const quantity = fc.oneof(
  fc.integer({ min: 1, max: 20 }),
  fc.integer({ min: 1, max: 160 }).map((n) => n / 8),
);

const item: fc.Arbitrary<PricedCartItemInput> = fc.record({
  unitPrice: fc.oneof(money(500), money(500_000)),
  quantity,
  discounts: fc.array(discount, { maxLength: 2 }),
  isReturn: fc.oneof(
    { arbitrary: fc.constant(false), weight: 4 },
    { arbitrary: fc.constant(true), weight: 1 },
  ),
});

// Many identical cheap lines are where per-line rounding of the order
// discount goes wrong, so they are generated on purpose next to random carts.
const repeatedLines: fc.Arbitrary<PricedCartItemInput[]> = fc
  .tuple(money(300), fc.integer({ min: 2, max: 12 }))
  .map(([unitPrice, n]) => Array.from({ length: n }, () => ({ unitPrice, quantity: 1 })));

const cart: fc.Arbitrary<PricedCartItemInput[]> = fc.oneof(
  fc.array(item, { minLength: 1, maxLength: 12 }),
  repeatedLines,
);

const options = fc.record({
  taxRate: fc.oneof(
    fc.integer({ min: 0, max: 15_000 }).map((n) => n / 100_000),
    fc.array(
      fc.integer({ min: 0, max: 15_000 }).map((n) => n / 100_000),
      { maxLength: 12 },
    ),
  ),
  orderDiscount: fc.option(
    fc.oneof(discount, fc.record({ type: fc.constant("AMOUNT" as const), value: money(300) })),
    { nil: null },
  ),
});

describe("priceCart (lib/pos/cartPricing.ts)", () => {
  it("every total equals the sum of its parts, to the cent", () => {
    fc.assert(
      fc.property(cart, options, (items, opts) => {
        const priced = priceCart(items, opts);
        expect(cents(priced.subtotal)).toBe(sumCents(priced.items.map((i) => i.lineSubtotal)));
        expect(sumCents(priced.items.map((i) => i.orderDiscountShare))).toBe(
          cents(priced.orderDiscountAmount),
        );
        expect(sumCents(priced.items.map((i) => i.netPrice))).toBe(cents(priced.netSubtotal));
        expect(cents(priced.netSubtotal)).toBe(
          cents(priced.subtotal) - cents(priced.orderDiscountAmount),
        );
        expect(cents(priced.taxAmount)).toBe(sumCents(priced.items.map((i) => i.vatAmount)));
        expect(cents(priced.total)).toBe(cents(priced.netSubtotal) + cents(priced.taxAmount));
      }),
    );
  });

  it("the order discount never exceeds the subtotal and never makes a line negative", () => {
    fc.assert(
      fc.property(cart, options, (items, opts) => {
        const priced = priceCart(items, opts);
        expect(priced.orderDiscountAmount).toBeGreaterThanOrEqual(0);
        expect(cents(priced.orderDiscountAmount)).toBeLessThanOrEqual(
          Math.max(cents(priced.subtotal), 0),
        );
        priced.items.forEach((line, i) => {
          // "This line's share of the order-level discount. Never negative."
          expect(line.orderDiscountShare).toBeGreaterThanOrEqual(0);
          if (items[i].isReturn) {
            // A return line absorbs no discount: that would discount money
            // being given back.
            expect(line.orderDiscountShare).toBe(0);
          } else {
            // A sale line can be made free, never negative (which would turn
            // a discount into a refund on that line).
            expect(cents(line.orderDiscountShare)).toBeLessThanOrEqual(cents(line.lineSubtotal));
            expect(line.netPrice).toBeGreaterThanOrEqual(0);
          }
        });
      }),
    );
  });

  it("item and order discounts are clamped to the price they discount", () => {
    fc.assert(
      fc.property(
        money(500_000),
        fc.array(discount, { maxLength: 4 }),
        fc.option(discount, { nil: null }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }).map((c) => c / 100),
        (unitPrice, discounts, orderDiscount, subtotal) => {
          const unit = discountedUnitPrice(unitPrice, discounts);
          expect(unit).toBeGreaterThanOrEqual(0);
          expect(unit).toBeLessThanOrEqual(unitPrice);
          const off = computeOrderDiscount(orderDiscount, subtotal);
          expect(off).toBeGreaterThanOrEqual(0);
          expect(off).toBeLessThanOrEqual(Math.max(subtotal, 0));
        },
      ),
    );
  });
});
