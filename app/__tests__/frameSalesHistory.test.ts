// /app/__tests__/frameSalesHistory.test.ts
//
// A-grade tests for the Slice 6.12 frame-sales-history helper.

import {
  computeFrameSalesHistory,
  trailingWindowStart,
  type FrameSaleLine,
} from "@/lib/frameSalesHistory";

const line = (qty: number, netPrice: number, salesOrderId: number): FrameSaleLine => ({
  qty,
  netPrice,
  salesOrderId,
});

describe("computeFrameSalesHistory", () => {
  it("sums units + revenue across multiple lines", () => {
    const r = computeFrameSalesHistory(
      [line(2, 5000, 100), line(1, 2500, 101), line(3, 7500, 102)],
      12,
    );
    expect(r.units).toBe(6);
    expect(r.revenue).toBe(15000);
    expect(r.distinctOrders).toBe(3);
    expect(r.windowMonths).toBe(12);
  });

  it("returns zeros for empty input", () => {
    const r = computeFrameSalesHistory([], 12);
    expect(r.units).toBe(0);
    expect(r.revenue).toBe(0);
    expect(r.distinctOrders).toBe(0);
  });

  it("dedupes orders that contributed multiple lines (one order, two line items)", () => {
    // Customer bought two frame variants on the same SO-SAMPLE order.
    const r = computeFrameSalesHistory([line(1, 1000, 50), line(1, 1200, 50)], 12);
    expect(r.distinctOrders).toBe(1);
    expect(r.units).toBe(2);
  });

  it("RETURNED lines (negative qty + negative netPrice) subtract correctly", () => {
    // Spring 2026 selling: 5 sold ($10K), 1 returned (-$2K). Net 4 units, $8K.
    const r = computeFrameSalesHistory(
      [
        line(5, 10000, 100),
        line(-1, -2000, 200), // SR-SAMPLE return on its own order id
      ],
      12,
    );
    expect(r.units).toBe(4);
    expect(r.revenue).toBe(8000);
    expect(r.distinctOrders).toBe(2);
  });

  it("rounds revenue to two decimals (Decimal-to-Number float drift)", () => {
    const r = computeFrameSalesHistory(
      [line(1, 100.10000000003, 1), line(1, 200.20000000005, 2)],
      12,
    );
    expect(r.revenue).toBe(300.3);
  });
});

describe("trailingWindowStart", () => {
  it("subtracts N months from `now` (UTC)", () => {
    const now = new Date("2026-05-14T12:00:00.000Z");
    expect(trailingWindowStart(now, 12)).toEqual(new Date("2025-05-14T12:00:00.000Z"));
  });

  it("handles December → February (year underflow)", () => {
    const now = new Date("2026-02-14T00:00:00.000Z");
    expect(trailingWindowStart(now, 12)).toEqual(new Date("2025-02-14T00:00:00.000Z"));
  });

  it("does not mutate the input Date", () => {
    const now = new Date("2026-05-14T00:00:00.000Z");
    const snapshot = now.getTime();
    trailingWindowStart(now, 12);
    expect(now.getTime()).toBe(snapshot);
  });

  it("supports custom window sizes (3 months for quick-recency check)", () => {
    const now = new Date("2026-05-14T00:00:00.000Z");
    expect(trailingWindowStart(now, 3)).toEqual(new Date("2026-02-14T00:00:00.000Z"));
  });
});
