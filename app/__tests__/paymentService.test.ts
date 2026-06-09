// /app/__tests__/paymentService.test.ts

import { round2, computeBalance, computeRefundable } from "@/lib/paymentService";

describe("round2", () => {
  it("rounds to two decimal places", () => {
    expect(round2(1.006)).toBe(1.01);
    expect(round2(1.004)).toBe(1);
    expect(round2(99.999)).toBe(100);
    expect(round2(0)).toBe(0);
    expect(round2(-5.556)).toBe(-5.56);
    expect(round2(49.995)).toBe(50);
  });

  it("handles whole numbers", () => {
    expect(round2(100)).toBe(100);
    expect(round2(0)).toBe(0);
  });

  it("handles floating point edge cases", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("computeBalance", () => {
  it("calculates total due from line items (netPrice is LINE TOTAL, not unit price)", () => {
    // Line 1: $500 total + $35 vat = $535
    // Line 2: qty 2 of something totaling $500 (stored as netPrice=500) + $35 vat = $535
    // Do NOT multiply netPrice by orderedQuantity — netPrice is already the line total.
    const result = computeBalance(
      [
        { netPrice: 500, orderedQuantity: 1, vatAmount: 35 },
        { netPrice: 500, orderedQuantity: 2, vatAmount: 35 },
      ],
      [],
    );
    expect(result.totalDue).toBe(1070);
    expect(result.totalPaid).toBe(0);
    expect(result.balanceDue).toBe(1070);
  });

  it("does not inflate totals for high-qty line items (the 2026-04-17 bug)", () => {
    // Regression test: rug pad line, 195 sq ft, stored as line total of $234
    // Old buggy behavior: 234 * 195 = $45,630 inflated line total
    // Correct: $234 line total regardless of quantity
    const result = computeBalance([{ netPrice: 234, orderedQuantity: 195, vatAmount: 0 }], []);
    expect(result.totalDue).toBe(234);
  });

  it("subtracts payments from balance", () => {
    const result = computeBalance(
      [{ netPrice: 1000, orderedQuantity: 1, vatAmount: 0 }],
      [
        { paymentAmount: 300, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 200, isRefund: false, status: "COMPLETED" },
      ],
    );
    expect(result.totalDue).toBe(1000);
    expect(result.totalPaid).toBe(500);
    expect(result.balanceDue).toBe(500);
  });

  it("excludes VOIDED payments", () => {
    const result = computeBalance(
      [{ netPrice: 1000, orderedQuantity: 1 }],
      [
        { paymentAmount: 500, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 200, isRefund: false, status: "VOIDED" },
      ],
    );
    expect(result.totalPaid).toBe(500);
    expect(result.balanceDue).toBe(500);
  });

  it("excludes FAILED payments", () => {
    const result = computeBalance(
      [{ netPrice: 1000, orderedQuantity: 1 }],
      [
        { paymentAmount: 500, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 300, isRefund: false, status: "FAILED" },
      ],
    );
    expect(result.totalPaid).toBe(500);
    expect(result.balanceDue).toBe(500);
  });

  it("subtracts refund amounts from total paid", () => {
    const result = computeBalance(
      [{ netPrice: 1000, orderedQuantity: 1 }],
      [
        { paymentAmount: 1000, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 200, isRefund: true, status: "COMPLETED" },
      ],
    );
    expect(result.totalPaid).toBe(800);
    expect(result.balanceDue).toBe(200);
  });

  it("handles refund with negative amount correctly", () => {
    const result = computeBalance(
      [{ netPrice: 1000, orderedQuantity: 1 }],
      [
        { paymentAmount: 1000, isRefund: false, status: "COMPLETED" },
        { paymentAmount: -200, isRefund: true, status: "COMPLETED" },
      ],
    );
    // isRefund uses -Math.abs(amt), so -200 becomes -200
    expect(result.totalPaid).toBe(800);
    expect(result.balanceDue).toBe(200);
  });

  it("handles null vatAmount", () => {
    const result = computeBalance([{ netPrice: 500, orderedQuantity: 1, vatAmount: null }], []);
    expect(result.totalDue).toBe(500);
  });

  it("handles string amounts from Prisma Decimal", () => {
    const result = computeBalance(
      [{ netPrice: "1499.99", orderedQuantity: "1", vatAmount: "104.99" }],
      [{ paymentAmount: "800.00", isRefund: false, status: "COMPLETED" }],
    );
    expect(result.totalDue).toBe(1604.98);
    expect(result.totalPaid).toBe(800);
    expect(result.balanceDue).toBe(804.98);
  });

  it("handles payments with null status", () => {
    const result = computeBalance(
      [{ netPrice: 500, orderedQuantity: 1 }],
      [{ paymentAmount: 500, isRefund: false, status: null }],
    );
    // null status should not be excluded
    expect(result.totalPaid).toBe(500);
    expect(result.balanceDue).toBe(0);
  });

  it("handles multiple quantities and tax (netPrice is LINE TOTAL)", () => {
    // Line 1: line total $100 (e.g. unit $33.33 × qty 3) + tax $19.13 = $119.13
    // Line 2: line total $50 + tax $15.94 = $65.94
    // Total: $185.07. netPrice is NOT multiplied by qty — already a line total.
    const result = computeBalance(
      [
        { netPrice: 100, orderedQuantity: 3, vatAmount: 19.13 },
        { netPrice: 50, orderedQuantity: 5, vatAmount: 15.94 },
      ],
      [],
    );
    expect(result.totalDue).toBe(185.07);
  });

  it("returns zero balance when fully paid", () => {
    const result = computeBalance(
      [{ netPrice: 2500, orderedQuantity: 1, vatAmount: 175 }],
      [{ paymentAmount: 2675, isRefund: false, status: "COMPLETED" }],
    );
    expect(result.balanceDue).toBe(0);
  });

  it("handles overpayment (negative balance)", () => {
    const result = computeBalance(
      [{ netPrice: 500, orderedQuantity: 1 }],
      [{ paymentAmount: 600, isRefund: false, status: "COMPLETED" }],
    );
    expect(result.balanceDue).toBe(-100);
  });

  it("handles empty line items and payments", () => {
    const result = computeBalance([], []);
    expect(result.totalDue).toBe(0);
    expect(result.totalPaid).toBe(0);
    expect(result.balanceDue).toBe(0);
  });

  it("snaps micro-balances to zero (the POS rounding)", () => {
    // $0.01 remaining — should be treated as paid in full
    const result = computeBalance(
      [{ netPrice: 500, orderedQuantity: 1 }],
      [{ paymentAmount: 499.99, isRefund: false, status: null }],
    );
    expect(result.balanceDue).toBe(0);
  });

  it("snaps small negative micro-balances to zero", () => {
    // $0.02 overpayment — should also snap to zero
    const result = computeBalance(
      [{ netPrice: 500, orderedQuantity: 1 }],
      [{ paymentAmount: 500.02, isRefund: false, status: null }],
    );
    expect(result.balanceDue).toBe(0);
  });

  it("preserves real balances above threshold", () => {
    // $1.50 remaining — real balance, should not snap
    const result = computeBalance(
      [{ netPrice: 500, orderedQuantity: 1 }],
      [{ paymentAmount: 498.5, isRefund: false, status: null }],
    );
    expect(result.balanceDue).toBe(1.5);
  });
});

describe("computeRefundable", () => {
  it("returns full amount when no prior refunds", () => {
    expect(computeRefundable(500, [])).toBe(500);
  });

  it("subtracts prior refund amounts", () => {
    expect(computeRefundable(500, [100, 150])).toBe(250);
  });

  it("uses absolute values of refund amounts", () => {
    expect(computeRefundable(500, [-100, -150])).toBe(250);
  });

  it("returns zero when fully refunded", () => {
    expect(computeRefundable(500, [300, 200])).toBe(0);
  });

  it("handles single partial refund", () => {
    expect(computeRefundable(1000, [250])).toBe(750);
  });

  it("handles floating point amounts", () => {
    expect(computeRefundable(99.99, [33.33, 33.33])).toBe(33.33);
  });
});
