// /app/src/lib/historicalPoImport.ts
//
// Slice 6.13 (2026-05-22) — Pure helper for importing an existing
// real `PurchaseOrder` into a `BuyerDraftBuy` as a `BuyerDraftPurchaseOrder`
// + N `BuyerDraftItem` rows, so Slice 6 performance reports (sell-through,
// dead stock, future-buy budgeting) can run against historical buys
// without the buyer having to recreate them by hand.
//
// Why this exists: the buyer-drafts workbench was designed forward-flow
// (draft items pre-the POS → CSV export → the POS imports → Slice 5
// auto-link → reports). To test the report against historical buys, we
// need a backward-flow path: take a real PO + its line items and
// synthesize the draft graph that would have produced it. The Slice 6.7
// linked-real-POs panel + the Slice 6.8.1 per-frame sales window then
// just work, because they key off `BuyerDraftItem.fulfilledProductId` —
// which we set at import time from `PurchaseOrderItem.productId`.
//
// Pure — no I/O. The API handler does the DB read of the real PO + the
// transactional write of the draft graph.

import type { BuyerDraftSource } from "@prisma/client";

/** Subset of PurchaseOrder we read for the import. */
export interface PurchaseOrderForImport {
  id: number;
  poNumber: string;
  vendorId: number;
  vendor: { name: string };
  orderDate: Date;
  expectedDelivery: Date | null;
  estimatedShipDate: Date | null;
  status: string;
  notes: string | null;
  lineItems: ReadonlyArray<PurchaseOrderItemForImport>;
}

/** Subset of PurchaseOrderItem we read for the import. */
export interface PurchaseOrderItemForImport {
  id: number;
  productId: number | null;
  orderedQuantity: { toString(): string };
  unitCost: { toString(): string };
  partNo: string | null;
  productName: string | null;
  product: {
    id: number;
    productNumber: string;
    name: string;
    baseRetail: { toString(): string } | null;
  } | null;
}

/** Create-shape for `BuyerDraftPurchaseOrder` row. The handler creates
 *  the row from this shape AND separately writes a row into
 *  `BuyerDraftPoRealPoLink` (using `realPoIdForLink` from the helper's
 *  return value) — the linkage is M:N as of Slice 6.14 (2026-05-22). */
export interface DraftPoCreateShape {
  vendorId: number;
  vendorName: string;
  referenceNumber: string;
  expectedShipMonth: Date | null;
  expectedDeliveryDate: Date | null;
  notes: string;
  status: "FULFILLED";
}

/** Create-shape for one `BuyerDraftItem` row. All field types match the
 *  Prisma create-input shape — strings for the Decimal fields (Prisma
 *  accepts string for Decimal inputs), Int for `qty`. */
export interface DraftItemCreateShape {
  vendorId: number;
  vendorName: string;
  partNumber: string;
  productName: string;
  cost: string;
  retail: string;
  qty: number;
  fulfilledProductId: number | null;
  fulfilledAt: Date | null;
  status: "FULFILLED";
  source: Extract<BuyerDraftSource, "HISTORICAL_PO_IMPORT">;
  notes: string;
}

/** Combined output of the helper — the draft PO shape + the draft item
 *  shapes + a per-line skip log so the handler can surface "5 items
 *  skipped, no Product link" warnings to the UI. */
export interface BuildImportResult {
  draftPo: DraftPoCreateShape;
  draftItems: DraftItemCreateShape[];
  /** The real PO id that should be written to BuyerDraftPoRealPoLink
   *  as `linkSource = HISTORICAL_IMPORT` alongside the draft PO insert.
   *  See Slice 6.14 for the M:N rationale. */
  realPoIdForLink: number;
  skipped: Array<{
    purchaseOrderItemId: number;
    reason: "no-product-link" | "zero-quantity";
    partNo: string | null;
  }>;
}

/**
 * Given a hydrated real PurchaseOrder, produce the create-shapes for the
 * draft PO + its items.
 *
 * Rules:
 *  - The draft PO inherits vendorId / vendorName, ETA fields, status
 *    `FULFILLED` (the items already exist + ship/receive history is on
 *    the real PO). The link to the real PO is written separately by
 *    the handler into `BuyerDraftPoRealPoLink` with
 *    `linkSource = HISTORICAL_IMPORT` — see `realPoIdForLink` on the
 *    return value.
 *  - One draft item per real PurchaseOrderItem WHERE `productId IS NOT NULL`.
 *    Items without a productId are skipped + reported (the buyer can fix
 *    those via Categorize Products and re-import — though re-import is
 *    blocked by the @unique FK once a real PO has been imported once;
 *    practically, skipped items remain a known gap, never blocking).
 *  - Item fields:
 *      * partNumber = PurchaseOrderItem.partNo, fallback to product.productNumber
 *      * productName = PurchaseOrderItem.productName, fallback to product.name
 *      * cost = PurchaseOrderItem.unitCost (line-level cost the buyer paid)
 *      * retail = product.baseRetail, fallback to cost (so the report's
 *                 margin math doesn't divide by zero; the Slice 6.1
 *                 display fallback will surface the catalog value if the
 *                 buyer's draft is blank — but Decimal columns aren't
 *                 nullable on items so we must seed SOMETHING)
 *      * qty = orderedQuantity, coerced to int (Decimal → number → trunc).
 *              Real POs occasionally carry fractional qty (e.g. fabric
 *              yardage) but the draft model uses Int. Truncate. Lines
 *              with qty <= 0 are SKIPPED + logged in `skipped` per
 *              CLAUDE.md rule 31 (zero-quantity the POS rows are
 *              cancelled lines — see partial-receive workflow note in
 *              docs/domains/POS-import.md).
 *      * fulfilledProductId = product.id (the linkage that makes Slice 6
 *                                          / 6.7 / 6.8.1 reports work)
 *      * fulfilledAt = the real PO's orderDate (best-available proxy for
 *                      "when did the buyer commit to this product?")
 *      * status = FULFILLED — the real PO/products already exist
 *      * source = HISTORICAL_PO_IMPORT — distinguishes from forward-flow drafts
 *  - `referenceNumber` on the draft PO is the real PON, so the workbench
 *    display + the linked-POs panel both render the real PO number even
 *    before the report's join recomputes.
 */
export function buildImportFromPurchaseOrder(po: PurchaseOrderForImport): BuildImportResult {
  const draftPo: DraftPoCreateShape = {
    vendorId: po.vendorId,
    vendorName: po.vendor.name,
    referenceNumber: po.poNumber,
    expectedShipMonth: firstOfMonthUtc(po.estimatedShipDate ?? po.expectedDelivery ?? po.orderDate),
    expectedDeliveryDate: po.expectedDelivery,
    notes: po.notes
      ? `Imported from PON ${po.poNumber} (2026-05-22 historical import).\n${po.notes}`
      : `Imported from PON ${po.poNumber} (2026-05-22 historical import).`,
    status: "FULFILLED",
  };

  const draftItems: DraftItemCreateShape[] = [];
  const skipped: BuildImportResult["skipped"] = [];

  for (const li of po.lineItems) {
    if (li.productId === null || li.product === null) {
      skipped.push({
        purchaseOrderItemId: li.id,
        reason: "no-product-link",
        partNo: li.partNo,
      });
      continue;
    }
    // CLAUDE.md rule 31: zero-quantity the POS rows are CANCELLED lines.
    // Importing them as qty=1 would inflate "qty ordered" in the Slice 6
    // report — phantom items the customer never bought. Same applies to
    // negative quantities (returns from another order chain). Skip + log.
    // Worked example: the 2026-05-22 partial-receive workflow the owner
    // described — when a PO partial-receives, the remainder gets cancelled
    // on the original PO (qty=0) and a NEW PO is created for the missing
    // items. Without this skip, the cancelled remainders would clutter
    // every historical-import as ghost qty=1 lines.
    const rawQty = Number(li.orderedQuantity.toString());
    if (!Number.isFinite(rawQty) || rawQty <= 0) {
      skipped.push({
        purchaseOrderItemId: li.id,
        reason: "zero-quantity",
        partNo: li.partNo,
      });
      continue;
    }
    const costStr = li.unitCost.toString();
    const retailStr = li.product.baseRetail ? li.product.baseRetail.toString() : costStr;
    const qtyInt = Math.max(1, Math.trunc(rawQty));
    draftItems.push({
      vendorId: po.vendorId,
      vendorName: po.vendor.name,
      partNumber: li.partNo ?? li.product.productNumber,
      productName: li.productName ?? li.product.name,
      cost: costStr,
      retail: retailStr,
      qty: qtyInt,
      fulfilledProductId: li.product.id,
      fulfilledAt: po.orderDate,
      status: "FULFILLED",
      source: "HISTORICAL_PO_IMPORT",
      notes: `Imported from PON ${po.poNumber} line ${li.id}`,
    });
  }

  return { draftPo, draftItems, realPoIdForLink: po.id, skipped };
}

/** Floor a Date to the first-of-month UTC. Used for `expectedShipMonth`
 *  which is `DateTime?` first-of-month per the 2026-05-13 promotion. */
function firstOfMonthUtc(d: Date | null): Date | null {
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
