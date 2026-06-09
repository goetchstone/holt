// /app/__tests__/historicalPoImport.test.ts
//
// Slice 6.13 (2026-05-22) — Pure-helper tests for the historical
// PurchaseOrder → BuyerDraftPurchaseOrder + BuyerDraftItem builder.
//
// No I/O. We construct PurchaseOrderForImport fixtures by hand and
// assert the output shape. Real-DB shape is covered by an integration
// test against fbc_test_db.

import {
  buildImportFromPurchaseOrder,
  type PurchaseOrderForImport,
  type PurchaseOrderItemForImport,
} from "@/lib/historicalPoImport";

function lineItem(overrides: Partial<PurchaseOrderItemForImport> = {}): PurchaseOrderItemForImport {
  const product = {
    id: 100,
    productNumber: "WH-12345",
    name: "Sofa, 90in",
    baseRetail: "4500.00",
  };
  return {
    id: 1,
    productId: 100,
    orderedQuantity: "2",
    unitCost: "1800.50",
    partNo: "WH-12345",
    productName: "Sofa, 90in",
    product,
    ...overrides,
  };
}

function purchaseOrder(overrides: Partial<PurchaseOrderForImport> = {}): PurchaseOrderForImport {
  return {
    id: 9001,
    poNumber: "PON12345",
    vendorId: 42,
    vendor: { name: "Wesley Hall" },
    orderDate: new Date(Date.UTC(2025, 9, 15)), // 2025-10-15 (October market)
    expectedDelivery: new Date(Date.UTC(2026, 2, 1)), // 2026-03-01
    estimatedShipDate: new Date(Date.UTC(2026, 1, 15)), // 2026-02-15
    status: "RECEIVED_FULL",
    notes: null,
    lineItems: [lineItem()],
    ...overrides,
  };
}

describe("buildImportFromPurchaseOrder", () => {
  it("creates a draft PO with the real PO's vendor, PON, ETA, and status FULFILLED", () => {
    const result = buildImportFromPurchaseOrder(purchaseOrder());
    expect(result.draftPo).toEqual({
      vendorId: 42,
      vendorName: "Wesley Hall",
      referenceNumber: "PON12345",
      // first-of-month UTC derived from estimatedShipDate (2026-02-15 → 2026-02-01)
      expectedShipMonth: new Date(Date.UTC(2026, 1, 1)),
      expectedDeliveryDate: new Date(Date.UTC(2026, 2, 1)),
      notes: "Imported from PON PON12345 (2026-05-22 historical import).",
      status: "FULFILLED",
    });
    // Slice 6.14: link is written separately to BuyerDraftPoRealPoLink
    expect(result.realPoIdForLink).toBe(9001);
  });

  it("creates one draft item per line item with productId, with linked product fields", () => {
    const result = buildImportFromPurchaseOrder(purchaseOrder());
    expect(result.draftItems).toHaveLength(1);
    expect(result.draftItems[0]).toEqual({
      vendorId: 42,
      vendorName: "Wesley Hall",
      partNumber: "WH-12345",
      productName: "Sofa, 90in",
      cost: "1800.50",
      retail: "4500.00",
      qty: 2,
      fulfilledProductId: 100,
      fulfilledAt: new Date(Date.UTC(2025, 9, 15)),
      status: "FULFILLED",
      source: "HISTORICAL_PO_IMPORT",
      notes: "Imported from PON PON12345 line 1",
    });
    expect(result.skipped).toHaveLength(0);
  });

  it("skips line items where productId is null, reports them in `skipped`", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [
          lineItem(),
          lineItem({ id: 2, productId: null, product: null, partNo: "MYSTERY-9" }),
          lineItem({ id: 3 }),
        ],
      }),
    );
    expect(result.draftItems).toHaveLength(2);
    expect(result.skipped).toEqual([
      { purchaseOrderItemId: 2, reason: "no-product-link", partNo: "MYSTERY-9" },
    ]);
  });

  it("falls back to product.productNumber when partNo is null", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [lineItem({ partNo: null })],
      }),
    );
    expect(result.draftItems[0].partNumber).toBe("WH-12345");
  });

  it("falls back to product.name when productName is null", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [lineItem({ productName: null })],
      }),
    );
    expect(result.draftItems[0].productName).toBe("Sofa, 90in");
  });

  it("uses unitCost as retail fallback when product.baseRetail is null", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [
          lineItem({
            unitCost: "999.99",
            product: {
              id: 100,
              productNumber: "WH-12345",
              name: "Sofa, 90in",
              baseRetail: null,
            },
          }),
        ],
      }),
    );
    expect(result.draftItems[0].cost).toBe("999.99");
    expect(result.draftItems[0].retail).toBe("999.99");
  });

  it("truncates fractional orderedQuantity to int (fabric yardage edge case)", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [lineItem({ orderedQuantity: "3.75" })],
      }),
    );
    expect(result.draftItems[0].qty).toBe(3);
  });

  // Rule 31: zero-quantity the POS rows are CANCELLED lines. Importing
  // them as qty=1 would inflate "qty ordered" in the Slice 6 report —
  // phantom items the customer never bought. Owner-described partial-
  // receive workflow: when a PO partial-receives, the remainder gets
  // cancelled on the original PO (qty=0) and a NEW PO is created for
  // the missing items. Without the skip, the cancelled remainders would
  // clutter every historical-import as ghost qty=1 lines.
  it("skips line items with orderedQuantity = 0 (rule 31 — cancelled lines)", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [
          lineItem({ id: 1 }),
          lineItem({ id: 2, orderedQuantity: "0", partNo: "CANCELLED-ITEM" }),
          lineItem({ id: 3 }),
        ],
      }),
    );
    expect(result.draftItems).toHaveLength(2);
    expect(result.skipped).toEqual([
      { purchaseOrderItemId: 2, reason: "zero-quantity", partNo: "CANCELLED-ITEM" },
    ]);
  });

  it("skips line items with negative orderedQuantity (returns from other chains)", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [
          lineItem({ id: 1 }),
          lineItem({ id: 2, orderedQuantity: "-3", partNo: "RETURN-LINE" }),
        ],
      }),
    );
    expect(result.draftItems).toHaveLength(1);
    expect(result.skipped).toEqual([
      { purchaseOrderItemId: 2, reason: "zero-quantity", partNo: "RETURN-LINE" },
    ]);
  });

  it("skips line items with NaN orderedQuantity defensively", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [lineItem({ id: 99, orderedQuantity: "not-a-number" })],
      }),
    );
    expect(result.draftItems).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("zero-quantity");
  });

  it("derives expectedShipMonth from estimatedShipDate when present", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        estimatedShipDate: new Date(Date.UTC(2026, 4, 17)), // 2026-05-17
        expectedDelivery: new Date(Date.UTC(2026, 5, 1)),
      }),
    );
    expect(result.draftPo.expectedShipMonth).toEqual(new Date(Date.UTC(2026, 4, 1)));
  });

  it("falls back to expectedDelivery for expectedShipMonth when estimatedShipDate is null", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        estimatedShipDate: null,
        expectedDelivery: new Date(Date.UTC(2026, 7, 22)), // 2026-08-22
      }),
    );
    expect(result.draftPo.expectedShipMonth).toEqual(new Date(Date.UTC(2026, 7, 1)));
  });

  it("falls back to orderDate for expectedShipMonth when both ETA fields are null", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        estimatedShipDate: null,
        expectedDelivery: null,
        orderDate: new Date(Date.UTC(2026, 0, 5)), // 2026-01-05
      }),
    );
    expect(result.draftPo.expectedShipMonth).toEqual(new Date(Date.UTC(2026, 0, 1)));
  });

  it("appends the real PO's existing notes to the historical-import note when present", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({ notes: "Receivable verified by Brian 2025-10-12" }),
    );
    expect(result.draftPo.notes).toBe(
      "Imported from PON PON12345 (2026-05-22 historical import).\nReceivable verified by Brian 2025-10-12",
    );
  });

  it("returns empty draftItems when the PO has zero line items", () => {
    const result = buildImportFromPurchaseOrder(purchaseOrder({ lineItems: [] }));
    expect(result.draftItems).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("returns only skipped lines when every line lacks a productId", () => {
    const result = buildImportFromPurchaseOrder(
      purchaseOrder({
        lineItems: [
          lineItem({ id: 1, productId: null, product: null, partNo: "A" }),
          lineItem({ id: 2, productId: null, product: null, partNo: "B" }),
        ],
      }),
    );
    expect(result.draftItems).toEqual([]);
    expect(result.skipped).toHaveLength(2);
  });

  it("returns realPoIdForLink so the handler can write the M:N join row (Slice 6.14)", () => {
    const result = buildImportFromPurchaseOrder(purchaseOrder({ id: 12345 }));
    expect(result.realPoIdForLink).toBe(12345);
    // The draft-PO create shape no longer carries the FK — the handler
    // writes the link separately into BuyerDraftPoRealPoLink.
    expect(result.draftPo).not.toHaveProperty("importedFromPurchaseOrderId");
  });
});
