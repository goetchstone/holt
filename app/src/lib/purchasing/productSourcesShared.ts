// /app/src/lib/purchasing/productSourcesShared.ts
//
// GAP-22: an item can be bought from more than one vendor (docs/DECISIONS.md
// 31). Its own vendor (Product.vendorId) stays the one for pricing and
// reports; the others are ProductSource rows. A purchase order has one vendor,
// and buyingTerms is the one rule for what that vendor may order: every path
// that puts a product on a PO asks it (the PO editor's picker, saving a PO,
// duplicating one).
//
// Shared by the product screen, the PO editor and the routes behind them.

/** The longest item number a vendor's own catalog is allowed. */
export const ITEM_NUMBER_MAX = 60;

/** One other vendor of an item, as the product screen shows it. */
export interface ProductSourceRow {
  id: number;
  vendorId: number;
  vendorName: string;
  /** That vendor's number for the item; null orders it under the item's own. */
  itemNumber: string | null;
  /** What that vendor charges, for a holder of "View cost". */
  cost?: number | null;
}

/** GET /api/products/[id]/sources. */
export interface ProductSourcesResponse {
  costVisible: boolean;
  sources: ProductSourceRow[];
}

/** What ordering an item from one vendor takes. */
export interface BuyingTerms {
  /** The number the vendor knows it by, printed on the PO line. */
  partNo: string;
  /** What it costs from that vendor; null when nobody has said. */
  cost: number | null;
}

/**
 * Whether `vendorId` sells us this item, and under what number and at what
 * cost: the item's own vendor uses the item's own number and cost; another
 * vendor of it uses its own, falling back to the item's where it has none;
 * any other vendor gets null and may not order it.
 */
export function buyingTerms(
  product: { vendorId: number; productNumber: string; baseCost: number | null },
  sources: readonly { vendorId: number; itemNumber: string | null; cost: number | null }[],
  vendorId: number,
): BuyingTerms | null {
  if (product.vendorId === vendorId) {
    return { partNo: product.productNumber, cost: product.baseCost };
  }
  const source = sources.find((s) => s.vendorId === vendorId);
  if (!source) return null;
  return {
    partNo: source.itemNumber ?? product.productNumber,
    cost: source.cost ?? product.baseCost,
  };
}
