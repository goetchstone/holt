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
  findForwardFlowOverlap,
  type PurchaseOrderForImport,
  type PurchaseOrderItemForImport,
  type ExistingBuyDraftItemForOverlapCheck,
  type IncomingLineForOverlapCheck,
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

// Slice 6.13.2 (2026-07-24) — forward-flow double-count guard. See
// docs/domains/buyer-drafts.md "Linked-PO scoping" section: a buy that
// already has forward-flow drafts AND gets a historical import
// covering the same products double-counts the budget rollup. This
// pure helper is what `import-purchase-order.ts` calls to refuse that
// import up front.
describe("findForwardFlowOverlap", () => {
  function line(overrides: Partial<IncomingLineForOverlapCheck> = {}): IncomingLineForOverlapCheck {
    return { productId: 100, partNo: "WH-12345", productName: "Sofa, 90in", ...overrides };
  }

  function existingItem(
    overrides: Partial<ExistingBuyDraftItemForOverlapCheck> = {},
  ): ExistingBuyDraftItemForOverlapCheck {
    return {
      id: 1,
      draftPoId: 10,
      partNumber: "WH-12345",
      productName: "Sofa, 90in",
      fulfilledProductId: 100,
      source: "MANUAL",
      status: "FULFILLED",
      ...overrides,
    };
  }

  it("returns empty when the buy has no existing items at all", () => {
    expect(findForwardFlowOverlap([line()], [])).toEqual([]);
  });

  it("returns empty when no existing item is linked to any product on the incoming PO", () => {
    const existing = [existingItem({ fulfilledProductId: 999, partNumber: "OTHER-1" })];
    expect(findForwardFlowOverlap([line({ productId: 100 })], existing)).toEqual([]);
  });

  it("flags an exact single-product overlap against a forward-flow (MANUAL) draft", () => {
    const existing = [existingItem({ source: "MANUAL" })];
    const result = findForwardFlowOverlap([line()], existing);
    expect(result).toEqual([
      {
        productId: 100,
        partNo: "WH-12345",
        productName: "Sofa, 90in",
        existingDrafts: [
          { id: 1, draftPoId: 10, partNumber: "WH-12345", productName: "Sofa, 90in" },
        ],
      },
    ]);
  });

  it("flags overlap against any forward-flow source (HD_PROPOSAL, APPAREL_SCAN, CONFIGURATOR)", () => {
    for (const source of ["HD_PROPOSAL", "APPAREL_SCAN", "CONFIGURATOR"]) {
      const existing = [existingItem({ source })];
      expect(findForwardFlowOverlap([line()], existing)).toHaveLength(1);
    }
  });

  it("does NOT flag overlap against an existing HISTORICAL_PO_IMPORT item (sibling-PO chaining stays unblocked)", () => {
    // A partial-receive split imports PON-A then PON-B, both covering
    // the same productIds by design (historicalPoSiblings.ts). That
    // must never trip this guard.
    const existing = [existingItem({ source: "HISTORICAL_PO_IMPORT" })];
    expect(findForwardFlowOverlap([line()], existing)).toEqual([]);
  });

  it("does NOT flag overlap against a CANCELLED forward-flow item (doc's stated resolution path)", () => {
    const existing = [existingItem({ source: "MANUAL", status: "CANCELLED" })];
    expect(findForwardFlowOverlap([line()], existing)).toEqual([]);
  });

  it("does NOT flag overlap against an unlinked forward-flow item (fulfilledProductId null)", () => {
    const existing = [existingItem({ fulfilledProductId: null })];
    expect(findForwardFlowOverlap([line()], existing)).toEqual([]);
  });

  it("is scoped by buy — only compares against items passed in (caller pre-filters by buyId)", () => {
    // The helper itself has no buyId concept; the handler is
    // responsible for only passing items from `draftPo.buyId ===
    // targetBuyId`. This test documents that contract: an "existing"
    // item representing a DIFFERENT buy simply shouldn't be in the
    // input array, and if it's absent, no overlap is flagged even
    // though the productId matches.
    const result = findForwardFlowOverlap([line({ productId: 100 })], []);
    expect(result).toEqual([]);
  });

  it("reports partial overlap: only the colliding product is listed, non-colliding lines pass through untouched", () => {
    const existing = [existingItem({ fulfilledProductId: 100 })];
    const incoming = [
      line({ productId: 100, partNo: "WH-12345" }),
      line({ productId: 200, partNo: "WH-99999", productName: "Chair" }),
    ];
    const result = findForwardFlowOverlap(incoming, existing);
    expect(result).toHaveLength(1);
    expect(result[0].productId).toBe(100);
  });

  it("lists every colliding existing draft item when more than one forward-flow row shares the product", () => {
    const existing = [
      existingItem({ id: 1, draftPoId: 10, source: "MANUAL" }),
      existingItem({ id: 2, draftPoId: 11, source: "CONFIGURATOR", partNumber: "WH-12345-ALT" }),
    ];
    const result = findForwardFlowOverlap([line()], existing);
    expect(result).toHaveLength(1);
    expect(result[0].existingDrafts).toHaveLength(2);
    expect(result[0].existingDrafts.map((d) => d.id).sort()).toEqual([1, 2]);
  });

  it("dedupes when the incoming PO has two lines for the same product", () => {
    const existing = [existingItem()];
    const incoming = [line({ productId: 100 }), line({ productId: 100, partNo: "WH-12345-B" })];
    const result = findForwardFlowOverlap(incoming, existing);
    expect(result).toHaveLength(1);
  });

  it("ignores incoming lines with null productId (unlinked real-PO line items)", () => {
    const existing = [existingItem()];
    expect(findForwardFlowOverlap([line({ productId: null })], existing)).toEqual([]);
  });

  it("sorts results by productId ascending for deterministic output", () => {
    const existing = [
      existingItem({ id: 1, fulfilledProductId: 300 }),
      existingItem({ id: 2, fulfilledProductId: 100 }),
      existingItem({ id: 3, fulfilledProductId: 200 }),
    ];
    const incoming = [line({ productId: 300 }), line({ productId: 100 }), line({ productId: 200 })];
    const result = findForwardFlowOverlap(incoming, existing);
    expect(result.map((o) => o.productId)).toEqual([100, 200, 300]);
  });

  it("different buy → allowed (empty existingBuyItems simulates a buy with no prior drafts)", () => {
    // Mirrors the handler's contract: existingBuyItems is scoped to
    // ONE buyId. A sibling buy with forward-flow drafts on the same
    // product must never surface here because the handler never
    // includes it in the query.
    expect(findForwardFlowOverlap([line()], [])).toEqual([]);
  });
});
