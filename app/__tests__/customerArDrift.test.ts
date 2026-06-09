// /app/__tests__/customerArDrift.test.ts
//
// A-grade tests for the customer AR-drift comparison helper.

import {
  compareCustomerArBalances,
  selectCustomersForCheck,
  type CustomerArInput,
} from "@/lib/customerArDrift";

/** Quick builder for the lineItem + payment shapes that `OrderForLedgerSource` expects. */
function order(
  lineTotals: ReadonlyArray<number>,
  paymentAmounts: ReadonlyArray<number>,
  options: {
    cancelledLineIndices?: ReadonlyArray<number>;
    refundIndices?: ReadonlyArray<number>;
  } = {},
): CustomerArInput["orders"][number] {
  const cancelled = new Set(options.cancelledLineIndices ?? []);
  const refund = new Set(options.refundIndices ?? []);
  return {
    lineItems: lineTotals.map((amt, i) => ({
      netPrice: amt,
      vatAmount: 0,
      lineItemStatus: cancelled.has(i) ? "CANCELLED" : "ACTIVE",
    })),
    payments: paymentAmounts.map((amt, i) => ({
      paymentAmount: amt,
      isRefund: refund.has(i),
      status: "COMPLETED",
    })),
  };
}

describe("compareCustomerArBalances", () => {
  it("counts a customer as OK when stored matches source within tolerance", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 1,
        label: "Smith, J",
        storedBalance: 200,
        orders: [order([1000], [800])], // due 1000 - paid 800 = 200
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.checked).toBe(1);
    expect(r.ok).toBe(1);
    expect(r.drifted).toHaveLength(0);
    expect(r.totalAbsoluteDrift).toBe(0);
  });

  it("flags a customer when stored is BELOW source (under-billed)", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 2,
        label: "Jones, K",
        storedBalance: 100, // we think they owe 100
        orders: [order([500], [200])], // source says they owe 300
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.ok).toBe(0);
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0].storedBalance).toBe(100);
    expect(r.drifted[0].sourceBalance).toBe(300);
    expect(r.drifted[0].diff).toBe(-200); // stored - source = negative
    expect(r.totalAbsoluteDrift).toBe(200);
  });

  it("flags a customer when stored is ABOVE source (over-billed in stored)", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 3,
        label: "Doe, A",
        storedBalance: 500, // stored says they owe 500
        orders: [order([300], [100])], // source says they owe 200
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0].diff).toBe(300); // +300 stored > source
  });

  it("excludes CANCELLED line items from source balance per CLAUDE.md rule 33", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 4,
        label: "Cancelled-Line",
        storedBalance: 200,
        orders: [order([300, 100], [200], { cancelledLineIndices: [1] })],
        // Active line: 300. Cancelled line: 100 (excluded). Paid: 200. Source = 100.
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0].sourceBalance).toBe(100);
    expect(r.drifted[0].diff).toBe(100); // stored 200 - source 100 = +100
  });

  it("treats refunds as negative payments (refund REDUCES totalPaid → INCREASES source balance)", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 5,
        label: "Refund-test",
        // Order $500. Paid $400. Refunded $100 of that. Net paid = $300. Owed = $200.
        storedBalance: 200,
        orders: [order([500], [400, 100], { refundIndices: [1] })],
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.ok).toBe(1);
    expect(r.drifted).toHaveLength(0);
  });

  it("considers half-cent drift as still OK (LEDGER_TOLERANCE)", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 6,
        label: "Rounding",
        storedBalance: 100.004, // 4/10ths of a cent off
        orders: [order([100], [0])],
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.ok).toBe(1);
  });

  it("flags drift of exactly 1 cent (above LEDGER_TOLERANCE)", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 7,
        label: "Penny-off",
        storedBalance: 100.01,
        orders: [order([100], [0])],
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0].diff).toBeCloseTo(0.01, 2);
  });

  it("sorts drifted rows by absolute diff descending — biggest problems first", () => {
    const inputs: CustomerArInput[] = [
      { customerId: 1, label: "small", storedBalance: 100, orders: [order([50], [0])] },
      { customerId: 2, label: "big", storedBalance: 100, orders: [order([5000], [0])] },
      { customerId: 3, label: "medium", storedBalance: 100, orders: [order([500], [0])] },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.drifted.map((d) => d.label)).toEqual(["big", "medium", "small"]);
  });

  it("sums totalAbsoluteDrift across all flagged customers", () => {
    const inputs: CustomerArInput[] = [
      { customerId: 1, label: "a", storedBalance: 0, orders: [order([100], [0])] }, // -100
      { customerId: 2, label: "b", storedBalance: 0, orders: [order([50], [0])] }, // -50
      { customerId: 3, label: "ok", storedBalance: 200, orders: [order([200], [0])] }, // ok
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.totalAbsoluteDrift).toBe(150);
    expect(r.ok).toBe(1);
    expect(r.drifted).toHaveLength(2);
  });

  it("returns an empty report for empty input (no crash)", () => {
    const r = compareCustomerArBalances([]);
    expect(r.checked).toBe(0);
    expect(r.ok).toBe(0);
    expect(r.drifted).toEqual([]);
    expect(r.totalAbsoluteDrift).toBe(0);
  });

  it("filters VOIDED payments from the source side", () => {
    const inputs: CustomerArInput[] = [
      {
        customerId: 8,
        label: "voided",
        // Stored ignores the VOIDED payment; source must too.
        storedBalance: 500,
        orders: [
          {
            lineItems: [{ netPrice: 500, vatAmount: 0, lineItemStatus: "ACTIVE" }],
            payments: [{ paymentAmount: 200, isRefund: false, status: "VOIDED" }],
          },
        ],
      },
    ];
    const r = compareCustomerArBalances(inputs);
    expect(r.ok).toBe(1); // VOIDED excluded; due=500, paid=0, source=500
  });
});

describe("selectCustomersForCheck", () => {
  it("dedups + sorts the union of both input sets", () => {
    const ids = selectCustomersForCheck({
      paymentCustomerIds: [3, 1, 5],
      ledgerCustomerIds: [2, 1, 4],
    });
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles either source being empty", () => {
    expect(selectCustomersForCheck({ paymentCustomerIds: [], ledgerCustomerIds: [7, 9] })).toEqual([
      7, 9,
    ]);
    expect(selectCustomersForCheck({ paymentCustomerIds: [4, 2], ledgerCustomerIds: [] })).toEqual([
      2, 4,
    ]);
  });

  it("returns empty when both are empty (caller decides cold-start fallback)", () => {
    expect(selectCustomersForCheck({ paymentCustomerIds: [], ledgerCustomerIds: [] })).toEqual([]);
  });
});
