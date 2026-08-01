// /app/src/lib/apparelOrderToBuyerDraft.ts
//
// THE key adaptation for the Apparel Order Import tool: turns a parsed +
// normalized vendor order (lib/apparelOrderVendors.ts: ApparelOrderDraft /
// ApparelOrderRow) into the payload shapes holt's existing Buyer Drafts
// API contract accepts (lib/buyerDraftRequestBody.ts: BuyerDraftPoCreateBody
// / BuyerDraftItemCreateBody).
//
// FC's equivalent (apparelOrdoriteExport.ts) built CSV rows for direct
// download into Ordorite -- holt is its own system of record for buyer
// drafts, so this tool creates DB rows instead: one BuyerDraftPurchaseOrder
// per import run, and one BuyerDraftItem per ApparelOrderRow (each row is
// already exploded to one size/part-number by the normalizers in
// apparelOrderVendors.ts -- one vendor order LINE often becomes several
// ApparelOrderRow entries, one per size ordered).
//
// Pure -- no I/O, no Prisma. The commit API endpoint
// (pages/api/tools/apparel-order/commit.ts) is the thin Prisma wrapper:
// it calls buildApparelDraftPoBody once, creates the PO, then calls
// buildApparelDraftItemBody once per row with the new PO's id and bulk-
// creates the items in the same transaction.

import type { ApparelOrderDraft, ApparelOrderRow } from "./apparelOrderVendors";
import type { BuyerDraftPoCreateBody, BuyerDraftItemCreateBody } from "./buyerDraftRequestBody";

// ─── Source stamp ──────────────────────────────────────────────────────
//
// BuyerDraftSource has no dedicated value for "parsed from a vendor order
// file" -- the closest existing value is APPAREL_SCAN ("barcode-scanned
// apparel item", reserved in buyer-drafts.md gotcha #6 for "future
// slices"). This tool IS that future slice's sibling: it's apparel-
// specific and it's not a manually-typed draft. Per the task's own
// fallback guidance we reuse APPAREL_SCAN rather than add a new
// BuyerDraftSource enum value + migration for a distinction (scanned vs.
// parsed-from-order-file) the buyer has no UI need to tell apart today.
// If that ever needs to change, add BuyerDraftSource.APPAREL_ORDER_IMPORT
// via an additive migration (see docs/domains/buyer-drafts.md "Historical
// PO import" section for the migration convention) and flip the constant
// below -- every call site reads it from here.
export const APPAREL_IMPORT_SOURCE = "APPAREL_SCAN" as const;

export interface ApparelDraftPoOptions {
  /** Real Vendor.id when the buyer picked one from the dropdown; null keeps vendorName free-text. */
  vendorId: number | null;
  /** Overrides draft.vendorName when the buyer edited/picked a different vendor label. */
  vendorName?: string;
  /** Buyer-assigned PO reference; falls back to the document's PO / order number. */
  referenceNumber?: string | null;
  /** "YYYY-MM" or any shape buyerDraftRequestBody's coerceShipMonthInput accepts. */
  expectedShipMonth?: string | null;
  expectedDeliveryDate?: string | null;
  storeLocationId?: number | null;
  buyId?: number | null;
}

/** Compose the draft PO's notes: an audit trail of what was imported, plus any parser warnings. */
export function buildApparelPoNotes(draft: ApparelOrderDraft): string {
  const parts: string[] = [];
  const orderRef = [draft.orderNumber, draft.poNumber].filter(Boolean).join(" / ");
  parts.push(
    `Imported via Apparel Order Import` +
      (orderRef ? ` (vendor order ${orderRef})` : "") +
      (draft.orderDate ? ` dated ${draft.orderDate}` : "") +
      (draft.season ? `, season ${draft.season}` : "") +
      ".",
  );
  if (draft.warnings && draft.warnings.length > 0) {
    parts.push(`Parser warnings: ${draft.warnings.join("; ")}`);
  }
  return parts.join("\n");
}

/** Build the create body for the draft PO that will hold every row's BuyerDraftItem. */
export function buildApparelDraftPoBody(
  draft: ApparelOrderDraft,
  options: ApparelDraftPoOptions,
): BuyerDraftPoCreateBody {
  return {
    vendorId: options.vendorId,
    vendorName: options.vendorName?.trim() || draft.vendorName || "Unknown Vendor",
    referenceNumber: options.referenceNumber || draft.poNumber || draft.orderNumber || null,
    expectedShipMonth: options.expectedShipMonth ?? null,
    expectedDeliveryDate: options.expectedDeliveryDate ?? null,
    storeLocationId: options.storeLocationId ?? null,
    buyId: options.buyId ?? null,
    notes: buildApparelPoNotes(draft),
  };
}

/** "Color: Ocean Blue, Size: M" -- free-text description for the OTHER
 *  item-type template (buyer-drafts.md: "OTHER skips both templates and
 *  lets the buyer fill description freely"). Blank parts are skipped. */
export function apparelItemDescription(row: Pick<ApparelOrderRow, "color" | "size">): string {
  const parts: string[] = [];
  if (row.color.trim()) parts.push(`Color: ${row.color.trim()}`);
  if (row.size.trim()) parts.push(`Size: ${row.size.trim()}`);
  return parts.join(", ");
}

export interface ApparelDraftItemOptions {
  /** Real Vendor.id when the buyer picked one from the dropdown; null keeps vendorName free-text. */
  vendorId: number | null;
  /** Batch-level department/category applied to every row (buyer can edit per-item afterward in the workbench). */
  departmentId: number | null;
  categoryId: number | null;
  stockLocationId: number | null;
  /** Marks every created item as part of the stocking program. Default false. */
  stockProgram?: boolean;
}

/**
 * Map one already-normalized order row to a BuyerDraftItem create body.
 * `draftPoId` is threaded in explicitly (rather than looked up) so this
 * stays pure and testable without a DB round trip -- the API endpoint
 * creates the PO first, then calls this once per row with the new id.
 */
export function buildApparelDraftItemBody(
  row: ApparelOrderRow,
  draftPoId: number | null,
  options: ApparelDraftItemOptions,
): BuyerDraftItemCreateBody {
  return {
    vendorId: options.vendorId,
    vendorName: row.supplier || "Unknown Vendor",
    partNumber: row.partNumber,
    productName: row.productName,
    cost: row.cost,
    // Selling Price is required (non-nullable Decimal on BuyerDraftItem) --
    // prefer the buyer's edited/prefilled Selling, fall back to MSRP, then
    // to cost so the row never round-trips to a $0 draft. buildItemCreateData
    // coerces via numberOrZero, so undefined/NaN also land safely at 0.
    retail: row.selling ?? row.msrp ?? row.cost,
    msrp: row.msrp,
    description: apparelItemDescription(row),
    departmentId: options.departmentId,
    categoryId: options.categoryId,
    // Apparel has no width/length/height -- left null so the item card
    // renders no dimension line (formatDimensions skips when all three
    // are absent).
    productWidth: null,
    productLength: null,
    productHeight: null,
    stockProgram: options.stockProgram ?? false,
    draftPoId,
    qty: row.qty,
    stockLocationId: options.stockLocationId,
    barcode: row.barcode || null,
    source: APPAREL_IMPORT_SOURCE,
    // itemType OTHER: apparel doesn't fit the UPHOLSTERY / CASE_GOODS
    // templates (buyer-drafts.md "The Item type templates"). Free-text
    // `description` above already carries color/size.
    itemType: "OTHER",
    notes: row.colorCode ? `Vendor color code: ${row.colorCode}` : null,
  };
}

/** Map every row in one import run to its BuyerDraftItem create body. */
export function buildApparelDraftItemBodies(
  rows: readonly ApparelOrderRow[],
  draftPoId: number | null,
  options: ApparelDraftItemOptions,
): BuyerDraftItemCreateBody[] {
  return rows.map((row) => buildApparelDraftItemBody(row, draftPoId, options));
}
