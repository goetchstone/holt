// /app/__tests__/poGapsForCaller.test.ts
//
// Pure unit tests for poGapsForCaller — the "View cost" edge of the Open PO
// Gaps report (SEC-14). No database: getPoGaps is covered by the page's
// integration test; this pins what each viewer receives.

import { poGapsForCaller, type PoGapRow, type PoGapsResult } from "@/lib/reports/poGaps";

// Every PoGapRow field, so a field added to the row type fails to compile here
// until it is given a value and, below, classified as cost or not.
const row = (overrides: Partial<PoGapRow>): PoGapRow => ({
  id: 1,
  poNumber: "PO-1",
  vendorName: "Acme Upholstery",
  orderDate: "2026-08-01",
  expectedDelivery: null,
  vendorAckNumber: null,
  vendorAckDate: null,
  status: "CONFIRMED",
  lineItemCount: 3,
  totalCost: 0,
  missingESD: true,
  missingAck: true,
  hasFurniture: true,
  ...overrides,
});

// Order-date order, as getPoGaps returns it. The costs (500, 5400, 120) follow
// date order in neither direction, so a re-sort by cost, either way, moves them.
const report: PoGapsResult = {
  total: 3,
  missingESD: 2,
  missingAck: 3,
  missingESDFurniture: 2,
  missingAckFurniture: 2,
  rows: [
    row({ id: 5, poNumber: "PO-5", orderDate: "2026-07-01", totalCost: 500 }),
    row({ id: 7, poNumber: "PO-7", orderDate: "2026-08-01", totalCost: 5400 }),
    row({
      id: 9,
      poNumber: "PO-9",
      orderDate: "2026-09-01",
      expectedDelivery: "2026-10-15",
      totalCost: 120,
      missingESD: false,
      hasFurniture: false,
    }),
  ],
};

describe("poGapsForCaller (View cost)", () => {
  it("a holder gets the report unchanged", () => {
    expect(poGapsForCaller(report, true)).toEqual({ ...report, costVisible: true });
  });

  it("anyone else gets every row and count without the PO cost, in the same order", () => {
    const blind = poGapsForCaller(report, false);
    expect(blind.costVisible).toBe(false);
    expect(blind).toMatchObject({
      total: 3,
      missingESD: 2,
      missingAck: 3,
      missingESDFurniture: 2,
      missingAckFurniture: 2,
    });
    expect(blind.rows.map((r) => r.poNumber)).toEqual(["PO-5", "PO-7", "PO-9"]);
    blind.rows.forEach((r, i) => {
      expect("totalCost" in r).toBe(false);
      // Put the cost back and the row is the holder's row exactly.
      expect({ ...r, totalCost: report.rows[i].totalCost }).toStrictEqual(report.rows[i]);
    });
  });

  it("carries exactly the non-cost keys, at the top and on every row", () => {
    const blind = poGapsForCaller(report, false);
    expect(Object.keys(blind).sort()).toEqual(
      [
        "costVisible",
        "missingAck",
        "missingAckFurniture",
        "missingESD",
        "missingESDFurniture",
        "rows",
        "total",
      ].sort(),
    );
    for (const r of blind.rows) {
      expect(Object.keys(r).sort()).toEqual(
        [
          "expectedDelivery",
          "hasFurniture",
          "id",
          "lineItemCount",
          "missingAck",
          "missingESD",
          "orderDate",
          "poNumber",
          "status",
          "vendorAckDate",
          "vendorAckNumber",
          "vendorName",
        ].sort(),
      );
    }
  });

  it("strips a copy, leaving the report it was given intact", () => {
    poGapsForCaller(report, false);
    expect(report.rows.map((r) => r.totalCost)).toEqual([500, 5400, 120]);
  });
});
