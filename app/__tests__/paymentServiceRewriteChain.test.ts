// /app/__tests__/paymentServiceRewriteChain.test.ts
//
// Regression test for the POS rewrite-chain fix. An earlier
// "cancel rewrite bases" attempt double-fixed the symptom of the
// phantom Gift Card payment that the POS attaches to rewrites -- it nuked
// the base and its accounting return to neutralize the phantom, but that
// broke daily sales date distribution. The correct fix is to skip the
// phantom during import and leave the chain active.
//
// This test pins the customer-level balance math across the full chain using
// a representative rewrite chain:
//
//   - Base order: $5,000 total, $3,000 card deposit
//   - Accounting return: -$5,000 line items, no payment
//   - Rewrite (<base> - A, dated a few days later): $4,800.01, no payment
//     (the phantom "Gift Card" $3,000 that the POS exports is skipped at import)
//
//   Customer balance over the chain: $5,000 - $3,000 - $5,000 + $4,800.01 = $1,800.01
//
// If the phantom Gift Card were imported, totalPaid would be $6,000 (doubled)
// and balanceDue would be $1,800.01 - $3,000 = -$1,199.99 (wrong -- shows $1,200
// credit for money the customer never paid).

import { computeBalance } from "@/lib/paymentService";

describe("computeBalance -- the POS rewrite chain", () => {
  it("nets to card_deposit-less rewrite_total when all three orders are active", () => {
    const chainLineItems = [
      // Base order line items
      { netPrice: 4700, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 300, orderedQuantity: 1, vatAmount: 0 }, // delivery charge
      // Accounting return (offsets the base)
      { netPrice: -4700, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: -300, orderedQuantity: 1, vatAmount: 0 },
      // Rewrite (<base> - A) line items
      { netPrice: 4500.01, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 300, orderedQuantity: 1, vatAmount: 0 },
    ];

    const chainPayments = [
      // Real card deposit on the base
      { paymentAmount: 3000, isRefund: false },
      // No payment on the return, no payment on the rewrite (phantom skipped)
    ];

    const result = computeBalance(chainLineItems, chainPayments);

    expect(result.totalDue).toBe(4800.01);
    expect(result.totalPaid).toBe(3000);
    expect(result.balanceDue).toBe(1800.01);
  });

  it("would over-credit the customer if the phantom Gift Card were imported", () => {
    // Same chain but with the POS phantom "Gift Card" payment imported.
    // This is the bug before that fix: totalPaid is doubled, balance is wrong.
    const chainLineItems = [
      { netPrice: 4700, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 300, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: -4700, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: -300, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 4500.01, orderedQuantity: 1, vatAmount: 0 },
      { netPrice: 300, orderedQuantity: 1, vatAmount: 0 },
    ];
    const chainPaymentsWithPhantom = [
      { paymentAmount: 3000, isRefund: false }, // real card
      { paymentAmount: 3000, isRefund: false }, // phantom gift card (should NOT be imported)
    ];
    const result = computeBalance(chainLineItems, chainPaymentsWithPhantom);

    expect(result.totalDue).toBe(4800.01);
    expect(result.totalPaid).toBe(6000);
    // Negative balance = credit owed to customer, which is false here
    expect(result.balanceDue).toBe(-1199.99);
  });

  it("same-amount product swap rewrite (same-total shape) still nets correctly", () => {
    // Base $3,000 with $1,000 card deposit, customer swapped to a different
    // $3,000 product. Rewrite has same total as base.
    //
    // Expected balance over the chain: -$1,000 + $3,000 = $2,000 owed.
    const chainLineItems = [
      { netPrice: 3000, orderedQuantity: 1, vatAmount: 0 }, // base
      { netPrice: -3000, orderedQuantity: 1, vatAmount: 0 }, // accounting return
      { netPrice: 3000, orderedQuantity: 1, vatAmount: 0 }, // rewrite
    ];
    const chainPayments = [{ paymentAmount: 1000, isRefund: false }];

    const result = computeBalance(chainLineItems, chainPayments);

    expect(result.totalDue).toBe(3000);
    expect(result.totalPaid).toBe(1000);
    expect(result.balanceDue).toBe(2000);
  });
});
