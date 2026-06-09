// /app/src/lib/buyerDraftFromProduct.ts
//
// Slice 4.5 — barcode lookup of existing Products into a draft.
//
// Pure helper: given a hydrated Product, return the create body for a
// new `BuyerDraftItem` that pre-fills the buyer's "Quick add" flow.
//
// Use case: buyer is re-ordering known stock (or adding an existing
// catalog item to a Buy/PO without re-typing). They scan / type a UPC
// in the BarcodeLookupModal; the modal POSTs the body returned here.
//
// Pure — no I/O. The API handler does the DB query + the POST chain.

/** Shape we expect from the API handler after Prisma hydration. Mirrors
 *  what `prisma.product.findFirst({ include: { vendor, department, category, type } })`
 *  produces, but only the fields we actually consume here. */
export interface ProductForDraft {
  id: number;
  productNumber: string;
  name: string;
  vendorId: number;
  vendor: { name: string };
  departmentId: number;
  categoryId: number;
  typeId: number | null;
  baseCost: { toString(): string } | null;
  baseRetail: { toString(): string } | null;
  mapPrice: { toString(): string } | null;
  width: number | null;
  depth: number | null;
  height: number | null;
}

/** Create-body shape matching what `pages/api/admin/buyer-drafts/items`
 *  POST expects (subset — only the fields we pre-fill). The buyer can
 *  edit anything via the wizard before/after the draft lands. */
export interface DraftItemFromProductBody {
  vendorId: number;
  vendorName: string;
  partNumber: string;
  productName: string;
  cost: string;
  retail: string;
  msrp: string | null;
  departmentId: number;
  categoryId: number;
  typeId: number | null;
  productWidth: string | null;
  productLength: string | null;
  productHeight: string | null;
  source: "MANUAL"; // catalog re-order is still a manual decision by the buyer
  notes: string;
  // Slice 6.1 (2026-05-12) — the buyer just told us "this catalog item IS
  // the draft" by scanning its barcode, so link them at create time. The
  // Slice 6 performance report and Slice 6.1 display fallback both read
  // `fulfilledProductId`; if we don't set it here the buyer would have to
  // wait for Slice 5's auto-link (which doesn't fire for already-catalog
  // items — there's no NEW UPC arriving in Stock-by-Item to match) or do
  // it by hand. Either way, breaks the "I scanned a barcode and now my
  // report shows sales" expectation.
  fulfilledProductId: number;
  fulfilledAt: string; // ISO timestamp set at create time
}

/**
 * Build the draft-item create body from a Product. Numbers come back as
 * strings so the POST body matches what `buildItemCreateData` expects
 * (decimals/dimensions are stringly typed across the buyer-drafts API).
 *
 * The buyer's intent here is "I want this exact item again" — so we
 * preserve all the catalog data including retail (which they often want
 * to keep stable). They can edit anything in the wizard if they need to.
 */
export function buildDraftBodyFromProduct(p: ProductForDraft): DraftItemFromProductBody {
  return {
    vendorId: p.vendorId,
    vendorName: p.vendor.name,
    partNumber: p.productNumber,
    productName: p.name,
    cost: p.baseCost ? p.baseCost.toString() : "0",
    retail: p.baseRetail ? p.baseRetail.toString() : "0",
    msrp: p.mapPrice ? p.mapPrice.toString() : null,
    departmentId: p.departmentId,
    categoryId: p.categoryId,
    typeId: p.typeId,
    productWidth: p.width === null ? null : String(p.width),
    productLength: p.depth === null ? null : String(p.depth),
    productHeight: p.height === null ? null : String(p.height),
    source: "MANUAL",
    notes: `Re-ordered from existing catalog: Product #${p.id}`,
    fulfilledProductId: p.id,
    fulfilledAt: new Date().toISOString(),
  };
}
