// /app/__tests__/paymentBalance.test.ts
//
// Unit coverage for the shared "which payments count as money received"
// rule (lib/paymentBalance.ts) that paymentService.computeBalance,
// customerLedger.computeSourceBalance, reports/balanceAging.getBalanceAging,
// and OrderDetailView's client-side total all now share. Pure functions, no
// I/O -- the whole point of extracting them here is that these exact cases
// can be pinned once instead of re-verified (and potentially drifting) at
// every call site.

import { isPaymentExcludedFromBalance, computeTotalPaid } from "@/lib/paymentBalance";

describe("isPaymentExcludedFromBalance", () => {
  it("excludes VOIDED, FAILED, and PENDING", () => {
    expect(isPaymentExcludedFromBalance("VOIDED")).toBe(true);
    expect(isPaymentExcludedFromBalance("FAILED")).toBe(true);
    expect(isPaymentExcludedFromBalance("PENDING")).toBe(true);
  });

  it("does NOT exclude REFUNDED — it's the original payment, netted by a separate refund row", () => {
    expect(isPaymentExcludedFromBalance("REFUNDED")).toBe(false);
  });

  it("does NOT exclude COMPLETED", () => {
    expect(isPaymentExcludedFromBalance("COMPLETED")).toBe(false);
  });

  it("does NOT exclude null or undefined — legacy POS-imported rows are real money (CLAUDE.md rule 51)", () => {
    expect(isPaymentExcludedFromBalance(null)).toBe(false);
    expect(isPaymentExcludedFromBalance(undefined)).toBe(false);
  });
});

describe("computeTotalPaid", () => {
  it("sums COMPLETED payments", () => {
    expect(
      computeTotalPaid([
        { paymentAmount: 300, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 200, isRefund: false, status: "COMPLETED" },
      ]),
    ).toBe(500);
  });

  it("excludes PENDING — the bug this whole file exists to prevent recurring", () => {
    expect(
      computeTotalPaid([
        { paymentAmount: 300, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 9000, isRefund: false, status: "PENDING" },
      ]),
    ).toBe(300);
  });

  it("excludes VOIDED and FAILED", () => {
    expect(
      computeTotalPaid([
        { paymentAmount: 300, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 100, isRefund: false, status: "VOIDED" },
        { paymentAmount: 50, isRefund: false, status: "FAILED" },
      ]),
    ).toBe(300);
  });

  it("includes null-status rows at full weight (legacy POS imports)", () => {
    expect(computeTotalPaid([{ paymentAmount: 500, isRefund: false, status: null }])).toBe(500);
  });

  it("subtracts isRefund rows regardless of sign on the stored amount", () => {
    expect(
      computeTotalPaid([
        { paymentAmount: 1000, isRefund: false, status: "COMPLETED" },
        { paymentAmount: 200, isRefund: true, status: "COMPLETED" },
      ]),
    ).toBe(800);
    expect(
      computeTotalPaid([
        { paymentAmount: 1000, isRefund: false, status: "COMPLETED" },
        { paymentAmount: -200, isRefund: true, status: "COMPLETED" },
      ]),
    ).toBe(800);
  });

  it("returns 0 for an empty array", () => {
    expect(computeTotalPaid([])).toBe(0);
  });
});
