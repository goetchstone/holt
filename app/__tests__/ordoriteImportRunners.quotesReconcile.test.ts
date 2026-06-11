// /app/__tests__/ordoriteImportRunners.quotesReconcile.test.ts
//
// Pure-helper tests for buildQuoteLineData — a stateless
// CSV-row-to-Prisma-shape mapper, no I/O.
//
// HISTORY: this file used to also contain ~250 lines of mocked-Prisma
// orchestration tests for runQuotesImport's reconcile path. Those
// were Phase 0.6 placeholder tests and were converted to real-DB
// integration tests under
// __tests__/integration/quotesReconcile.integration.test.ts on
// 2026-04-30. The integration version covers all 4 original scenarios
// plus 2 real-DB-only scenarios (idempotency, cancelled-line
// stickiness on re-import) that the mocked tests structurally could
// not assert.

import { buildQuoteLineData } from "@/lib/adapters/ordorite/runners";

describe("buildQuoteLineData (pure helper)", () => {
  test("maps a typical CSV row to the OrderLineItem shape", () => {
    const row = {
      "Part No": "AL-KAD-RO3-ST",
      "Product Name": "Kaden Classics Motion Sofa",
      Orderqty: 1,
      "Sellingprice Exvat": 7575,
    };
    const out = buildQuoteLineData(row);
    expect(out.partNo).toBe("AL-KAD-RO3-ST");
    expect(out.productName).toBe("Kaden Classics Motion Sofa");
    expect(out.orderedQuantity).toBe(1);
    expect(out.netPrice).toBe(7575);
    // Quote CSVs do not carry separate cost data; cost defaults to the
    // selling price (will be reconciled when the quote becomes a sale).
    expect(out.cost).toBe(7575);
  });

  test("returns undefined for missing optional fields rather than empty string", () => {
    const out = buildQuoteLineData({});
    expect(out.partNo).toBeUndefined();
    expect(out.productName).toBeUndefined();
    expect(out.orderedQuantity).toBe(0);
    expect(out.netPrice).toBe(0);
    expect(out.cost).toBe(0);
  });

  test("falls back to lowercase column name 'Qty' for quantity", () => {
    const out = buildQuoteLineData({ Qty: 5, "Part No": "X" });
    expect(out.orderedQuantity).toBe(5);
  });

  test("uses Cost column when distinct from Sellingprice Exvat", () => {
    const out = buildQuoteLineData({
      "Sellingprice Exvat": 100,
      Cost: 60,
    });
    // Per the helper's logic, Sellingprice Exvat wins for both netPrice
    // AND cost when present (quote CSV invariant). Cost field is fallback.
    expect(out.netPrice).toBe(100);
    expect(out.cost).toBe(100);
  });

  test("falls back to lowercase 'netprice' when capitalized form is absent", () => {
    const out = buildQuoteLineData({ netprice: 250 });
    expect(out.netPrice).toBe(250);
    expect(out.cost).toBe(250);
  });
});
