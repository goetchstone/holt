// /app/__tests__/unclassifiedReturns.test.ts
//
// Pure unit tests for the B3 "Unclassified Returns" exception report:
// buildUnclassifiedReturnsRows (row shaping) and explainUnclassified (the
// accountant-facing reason text). No database — the query half
// (getUnclassifiedReturns) is a thin Prisma read validated against real data;
// this pins the row-selection and reason logic, and reuses the SAME
// matchReturnForLine/resolveReturnBookingPath helpers the JE generator uses
// so the report can never disagree with what was actually booked.

import {
  buildUnclassifiedReturnsRows,
  explainUnclassified,
  type RawReturnOrderRow,
} from "@/lib/reports/unclassifiedReturns";
import type { ReturnForJournal } from "@/lib/journalEntry";

const meta = { startDate: "2026-01-01", endDate: "2026-06-05" };

function makeOrder(overrides: Partial<RawReturnOrderRow> = {}): RawReturnOrderRow {
  return {
    id: 1,
    orderno: "SR-1001",
    orderDate: new Date("2026-05-01T00:00:00Z"),
    storeLocation: "Main",
    customer: { firstName: "Jane", lastName: "Doe" },
    lineItems: [],
    returns: [],
    ...overrides,
  };
}

function makeReturn(overrides: Partial<ReturnForJournal> = {}): ReturnForJournal {
  return {
    id: 1,
    lineItemId: null,
    productId: null,
    status: "INSPECTED",
    inspectionCondition: null,
    ...overrides,
  };
}

describe("explainUnclassified", () => {
  it("says 'No Return record' when the order has none (the imported-POS shape)", () => {
    expect(explainUnclassified({ id: 1, productId: 5 }, [])).toMatch(/No Return record/);
  });

  it("flags ambiguous match when Return records exist but none link to this line", () => {
    const returns = [makeReturn({ id: 1, productId: 999 }), makeReturn({ id: 2, productId: 888 })];
    expect(explainUnclassified({ id: 1, productId: 5 }, returns)).toMatch(/ambiguous match/);
  });

  it("flags not-yet-classified when a Return matches but has no disposition signal", () => {
    const returns = [makeReturn({ id: 1, productId: 5, status: "RECEIVED" })];
    expect(explainUnclassified({ id: 1, productId: 5 }, returns)).toMatch(
      /hasn.t been inspected\/classified/,
    );
  });
});

describe("buildUnclassifiedReturnsRows", () => {
  it("includes a return-shaped line with no Return record at all", () => {
    const orders = [
      makeOrder({
        lineItems: [
          { id: 10, productId: 5, productName: "Test Sofa", partNo: "SOFA-1", netPrice: -500 },
        ],
        returns: [],
      }),
    ];
    const { rows, totals } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(500);
    expect(rows[0].orderno).toBe("SR-1001");
    expect(rows[0].store).toBe("Main");
    expect(rows[0].customerName).toBe("Jane Doe");
    expect(rows[0].reason).toMatch(/No Return record/);
    expect(totals.count).toBe(1);
    expect(totals.totalAmount).toBe(500);
  });

  it("EXCLUDES a return-shaped line that has a classified RESTOCKED Return", () => {
    const orders = [
      makeOrder({
        lineItems: [
          { id: 10, productId: 5, productName: "Test Sofa", partNo: "SOFA-1", netPrice: -500 },
        ],
        returns: [makeReturn({ id: 1, productId: 5, status: "RESTOCKED" })],
      }),
    ];
    const { rows } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows).toHaveLength(0);
  });

  it("EXCLUDES a return-shaped line that has a classified WRITTEN_OFF Return", () => {
    const orders = [
      makeOrder({
        lineItems: [
          { id: 10, productId: 5, productName: "Test Sofa", partNo: "SOFA-1", netPrice: -500 },
        ],
        returns: [makeReturn({ id: 1, productId: 5, status: "WRITTEN_OFF" })],
      }),
    ];
    const { rows } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows).toHaveLength(0);
  });

  it("INCLUDES a return-shaped line whose Return record exists but isn't classified yet", () => {
    const orders = [
      makeOrder({
        lineItems: [
          { id: 10, productId: 5, productName: "Test Sofa", partNo: "SOFA-1", netPrice: -500 },
        ],
        returns: [
          makeReturn({ id: 1, productId: 5, status: "RECEIVED", inspectionCondition: null }),
        ],
      }),
    ];
    const { rows } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/hasn.t been inspected\/classified/);
  });

  it("ignores non-return (positive netPrice) lines entirely", () => {
    const orders = [
      makeOrder({
        lineItems: [
          { id: 10, productId: 5, productName: "Sale line", partNo: null, netPrice: 500 },
        ],
      }),
    ];
    const { rows } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows).toHaveLength(0);
  });

  it("handles multiple lines on one order independently by product match", () => {
    const orders = [
      makeOrder({
        lineItems: [
          { id: 10, productId: 5, productName: "Written off item", partNo: null, netPrice: -500 },
          { id: 11, productId: 6, productName: "Unclassified item", partNo: null, netPrice: -100 },
        ],
        returns: [makeReturn({ id: 1, productId: 5, status: "WRITTEN_OFF" })],
      }),
    ];
    const { rows } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows).toHaveLength(1);
    expect(rows[0].lineItemId).toBe(11);
    expect(rows[0].amount).toBe(100);
  });

  it("falls back to 'Unknown' customer and 'Unassigned' store when missing", () => {
    const orders = [
      makeOrder({
        customer: null,
        storeLocation: null,
        lineItems: [{ id: 10, productId: null, productName: null, partNo: null, netPrice: -50 }],
      }),
    ];
    const { rows } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows[0].customerName).toBe("Unknown");
    expect(rows[0].store).toBe("Unassigned");
    expect(rows[0].description).toBe("line 10");
  });

  it("sorts rows by amount, highest first, and totals correctly", () => {
    const orders = [
      makeOrder({
        id: 1,
        orderno: "SR-1",
        lineItems: [{ id: 10, productId: null, productName: "Small", partNo: null, netPrice: -50 }],
      }),
      makeOrder({
        id: 2,
        orderno: "SR-2",
        lineItems: [{ id: 20, productId: null, productName: "Big", partNo: null, netPrice: -500 }],
      }),
    ];
    const { rows, totals } = buildUnclassifiedReturnsRows(orders, meta);
    expect(rows.map((r) => r.description)).toEqual(["Big", "Small"]);
    expect(totals.count).toBe(2);
    expect(totals.totalAmount).toBe(550);
  });

  it("returns empty rows/zero totals for no orders", () => {
    const { rows, totals } = buildUnclassifiedReturnsRows([], meta);
    expect(rows).toEqual([]);
    expect(totals).toEqual({ count: 0, totalAmount: 0 });
  });
});
