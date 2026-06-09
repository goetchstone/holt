// /app/__tests__/paymentServiceRewriteChain.test.ts
//
// Regression test for the 2026-04-23 the POS rewrite chain fix. The prior
// 2026-04-21 "cancel rewrite bases" attempt double-fixed the symptom of the
// phantom Gift Card payment that the POS attaches to rewrites -- it nuked
// the base and its accounting return to neutralize the phantom, but that
// broke daily sales date distribution. The correct fix is to skip the
// phantom during import and leave the chain active.
//
// This test pins the customer-level balance math across the full chain using
// the SO-1652 numbers from prod (captured in the 2026-04-23 investigation):
//
//   - Base SO-1652 (dated 2026-04-19): $8,159 total, Card Connect $4,339 deposit
//   - Return SR-1-equivalent: -$8,159 line items, no payment
//   - Rewrite SO-1652 - A (dated 2026-04-22): $7,809.01, no payment
//     (the phantom "Gift Card" $4,339 that the POS exports is skipped at import)
//
//   Customer balance over the chain: $8,159 - $4,339 - $8,159 + $7,809.01 = $3,470.01
//
// If the phantom Gift Card were imported, totalPaid would be $8,678 (doubled)
// and balanceDue would be $3,470.01 - $4,339 = -$868.99 (wrong -- shows $869
// credit for money the customer never paid).

import { computeBalance } from "@/lib/paymentService";

describe("computeBalance -- the POS rewrite chain", () => {
  it("nets to card_deposit-less rewrite_total when all three orders are active", () => {
    const chainLineItems = [
      // Base SO-1652 line items
      { netPrice: 7860, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 299, orderedQuantity: 1, vatAmount: 0 }, // delivery charge
      // Accounting return (offsets the base)
      { netPrice: -7860, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: -299, orderedQuantity: 1, vatAmount: 0 },
      // Rewrite SO-1652 - A line items
      { netPrice: 7510.01, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 299, orderedQuantity: 1, vatAmount: 0 },
    ];

    const chainPayments = [
      // Real card deposit on the base
      { paymentAmount: 4339, isRefund: false },
      // No payment on the return, no payment on the rewrite (phantom skipped)
    ];

    const result = computeBalance(chainLineItems, chainPayments);

    expect(result.totalDue).toBe(7809.01);
    expect(result.totalPaid).toBe(4339);
    expect(result.balanceDue).toBe(3470.01);
  });

  it("would over-credit the customer if the phantom Gift Card were imported", () => {
    // Same chain but with the POS phantom "Gift Card" payment imported.
    // This is the bug pre-2026-04-23: totalPaid is doubled, balance is wrong.
    const chainLineItems = [
      { netPrice: 7860, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 299, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: -7860, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: -299, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 7510.01, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 299, orderedQuantity: 1, vatAmount: 0 },
    ];
    const chainPaymentsWithPhantom = [
      { paymentAmount: 4339, isRefund: false }, // real card
      { paymentAmount: 4339, isRefund: false }, // phantom gift card (should NOT be imported)
    ];
    const result = computeBalance(chainLineItems, chainPaymentsWithPhantom);

    expect(result.totalDue).toBe(7809.01);
    expect(result.totalPaid).toBe(8678);
    // Negative balance = credit owed to customer, which is false here
    expect(result.balanceDue).toBe(-868.99);
  });

  it("same-amount product swap rewrite (SO-38971 shape) still nets correctly", () => {
    // Base $3,895 with $2,050 card deposit, customer swapped to a different
    // $3,895 product. Rewrite has same total as base.
    //
    // Expected balance over the chain: -$2,050 + $3,895 = $1,845 owed.
    const chainLineItems = [
      { netPrice: 3895, orderedQuantity: 1, vatAmount: 0 }, // base
      { netPrice: -3895, orderedQuantity: 1, vatAmount: 0 }, // accounting return
      { netPrice: 3895, orderedQuantity: 1, vatAmount: 0 }, // rewrite
    ];
    const chainPayments = [{ paymentAmount: 2050, isRefund: false }];

    const result = computeBalance(chainLineItems, chainPayments);

    expect(result.totalDue).toBe(3895);
    expect(result.totalPaid).toBe(2050);
    expect(result.balanceDue).toBe(1845);
  });
});
