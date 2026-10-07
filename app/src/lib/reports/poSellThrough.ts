// /app/src/lib/reports/poSellThrough.ts
//
// PO Sell-Thru report — per-line receive-date windowing.
//
// The report lets a manager pick multiple real purchase orders and see how
// much of what those POs delivered has since sold. The owner's requirement
// (2026-06-03): each PO line item's sell-through clock starts at THAT line's
// receive date — not one window for the whole report — and runs to today.
//
// This module is the novel, pure piece. The heavy sell-through math (frame
// rollup, stock-vs-special split, margins, status) is reused untouched from
// `lib/buyPerformance.ts`. The trick that lets us reuse it as-is: we PRE-WINDOW
// the sales here (drop any sale that happened before its product's receive
// date), then hand the already-windowed sales to `computePerformance` with no
// frame-level window. That gives true per-product (per-line) windowing while
// the engine just sees "valid sales."
//
// Window rule per product:
//   - A "stock" product (one literally on a selected PO) is windowed from its
//     own earliest receipt on those POs.
//   - A "special" frame-mate (a variant of the same frame that was NOT on the
//     selected POs — a customer-spec order) is windowed from the frame's
//     earliest stock receipt, so special sales are counted over the same
//     period the frame's stock was available.
//   - A product whose frame had NO stock receipt on the selected POs gets no
//     window and is excluded entirely (its frame isn't part of this selection).

/** One receipt of a product that was on a selected PO (stock side). */
export interface StockReceipt {
  productId: number;
  receivedDate: Date;
}

/**
 * Build the per-product sales-window start date.
 *
 * `productToFrame` is the frame universe (every product for the vendors of the
 * selected POs, so frame-mate variants can be classified as special). Only
 * products whose frame has at least one stock receipt end up with a window.
 */
export function buildProductWindowStarts(
  stockReceipts: readonly StockReceipt[],
  productToFrame: ReadonlyMap<number, string>,
): Map<number, Date> {
  // Earliest stock receipt per product.
  const earliestByProduct = new Map<number, Date>();
  for (const r of stockReceipts) {
    const cur = earliestByProduct.get(r.productId);
    if (cur === undefined || r.receivedDate < cur) {
      earliestByProduct.set(r.productId, r.receivedDate);
    }
  }

  // Earliest stock receipt per frame (min across the frame's stock products).
  const earliestByFrame = new Map<string, Date>();
  for (const [productId, date] of earliestByProduct) {
    const frameKey = productToFrame.get(productId);
    if (frameKey === undefined) continue;
    const cur = earliestByFrame.get(frameKey);
    if (cur === undefined || date < cur) earliestByFrame.set(frameKey, date);
  }

  // Window start for every product in an in-scope frame: its own receipt if it
  // has one (stock), else the frame's earliest stock receipt (special variant).
  const out = new Map<number, Date>();
  for (const [productId, frameKey] of productToFrame) {
    const own = earliestByProduct.get(productId);
    if (own !== undefined) {
      out.set(productId, own);
      continue;
    }
    const frameStart = earliestByFrame.get(frameKey);
    if (frameStart !== undefined) out.set(productId, frameStart);
  }
  return out;
}

/**
 * Keep only the sales that fall on or after their product's window start.
 * Sales of products with no window (frame not in the PO selection) or with no
 * usable orderDate are dropped. Generic over the sale shape so the API can pass
 * its `PerformanceSaleLine[]` straight through.
 */
export function windowSalesByReceipt<T extends { productId: number; orderDate?: Date | null }>(
  sales: readonly T[],
  windowStartByProduct: ReadonlyMap<number, Date>,
): T[] {
  return sales.filter((s) => {
    const start = windowStartByProduct.get(s.productId);
    if (start === undefined) return false;
    if (s.orderDate === null || s.orderDate === undefined) return false;
    return s.orderDate >= start;
  });
}

/**
 * Per-frame "realized retail" — how close the actual selling price came to full
 * list price, which shows full-retail vs discounted. For each sold line whose
 * product has a positive `baseRetail`, accumulate the actual revenue (netPrice)
 * and the full-list amount (baseRetail × qty). The ratio is computed apples-to-
 * apples over only the priced units (a unit with no/zero baseRetail can't be
 * judged against list, so it's excluded from BOTH sums).
 *
 * Caller turns this into `realizedRatio = soldRevenue / fullRetail` per frame
 * (null when fullRetail is 0): 1.0 ≈ sold at full list; 0.75 ≈ ~25% off.
 */
export function realizedRetailByFrame(
  sales: readonly { productId: number; qty: number; netPrice: number }[],
  productToFrame: ReadonlyMap<number, string>,
  baseRetailByProduct: ReadonlyMap<number, number>,
): Map<string, { soldRevenue: number; fullRetail: number }> {
  const out = new Map<string, { soldRevenue: number; fullRetail: number }>();
  for (const s of sales) {
    const frameKey = productToFrame.get(s.productId);
    if (frameKey === undefined) continue;
    const retail = baseRetailByProduct.get(s.productId);
    if (retail === undefined || retail <= 0) continue;
    const acc = out.get(frameKey) ?? { soldRevenue: 0, fullRetail: 0 };
    acc.soldRevenue += s.netPrice;
    acc.fullRetail += retail * s.qty;
    out.set(frameKey, acc);
  }
  return out;
}
