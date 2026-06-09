// /app/src/lib/buyPerformance.ts
//
// Slice 6 (2026-05-12) — Buy performance + compare-to-last-buy.
//
// Pure helper. Given:
//   - the buyer's drafts on a Buy (each with a `fulfilledProductId` from
//     Slice 5 auto-link)
//   - the sales lines (OrderLineItem rows) for the frame-mates of those
//     fulfilled Products (caller queries via `frameRollup.stripLastSegment`)
//   - the frame decisions (from `lib/frameRollup.buildFrameDecisions`)
//
// produce per-frame metrics: qty drafted, qty sold, cost, revenue,
// margin, sell-through ratio, and a status hint the UI shows next to
// the row ("scale up" / "dead" / "healthy" / "no link yet").
//
// The frame key is the unit of aggregation — multiple drafts for the
// same frame (different grades / fabrics / fills of the same sofa)
// roll up to one row. Same on the sales side: a draft for L2272 Grade
// 13 counts sales of L2272 Grade 16 + L2272 Grade 18 as "this frame
// sold."
//
// Excludes Marjan at the API layer (vendor.name = 'Marjan'). This
// helper is unaware; it just operates on whatever rows the caller
// hands it.

export interface PerformanceDraft {
  /** BuyerDraftItem.id */
  draftId: number;
  /** quantity the buyer planned to order */
  qty: number;
  /** unit cost on the draft (Decimal-as-string is fine — caller can pre-parse) */
  costPerUnit: number;
  /** retail/MSRP on the draft */
  retailPerUnit: number;
  /** If Slice 5 auto-linked, this points to the real Product row */
  fulfilledProductId: number | null;
  /** Frame key for this draft. Derived by the caller via frameRollup. */
  frameKey: string | null;
  /** Display label for the frame */
  frameLabel: string;
}

export interface PerformanceSaleLine {
  /** productId on the sold line — used to verify the line maps to a frame in scope */
  productId: number;
  /** qty sold on this line item */
  qty: number;
  /** netPrice is the LINE TOTAL (CLAUDE.md gotcha — already qty-multiplied) */
  netPrice: number;
  /** cost on the line, when present; falls back to draft cost in `computePerformance` */
  cost: number | null;
  /** Phase 6.8.1 (2026-05-14) — order date for per-frame window
   *  filtering. When `frameWindowStartByKey` is set, a sale is folded
   *  into a frame's bucket only if its orderDate ≥ that frame's
   *  earliest receivedDate. Null is treated as "before any window
   *  start" → excluded under per-frame filtering. */
  orderDate?: Date | null;
}

/** Phase 6.8 (2026-05-14) — receiving data for a frame's products.
 *  One row per `ReceivingRecord`, aggregated upstream. */
export interface PerformanceReceiptLine {
  /** productId on the received PO line. */
  productId: number;
  /** quantityReceived (positive). */
  qty: number;
}

/** Maps productId → frameKey for the sales lines, so we can fold each
 *  sold OrderLineItem into the right frame bucket. */
export type ProductFrameIndex = ReadonlyMap<number, string>;

export interface FramePerformance {
  frameKey: string;
  frameLabel: string;
  /** Sum of draft qty across all drafts on this frame (across all POs in the Buy). */
  qtyOrdered: number;
  /** Phase 6.8 (2026-05-14) — Σ ReceivingRecord.quantityReceived for
   *  every product in this frame, since the sales window start. Includes
   *  both stock and special variants. Helps the buyer answer "did my
   *  plan arrive?" alongside "did my plan sell?" */
  qtyReceived: number;
  /** Phase 6.8 — receipts of the buyer's drafted (linked) products only. */
  qtyStockReceived: number;
  /** Phase 6.8 — receipts of OTHER frame-mate variants (customer-spec
   *  special-order arrivals). Informational. */
  qtySpecialReceived: number;
  /** Sum of OrderLineItem.qty for sales of products in this frame
   *  (stock + special combined). */
  qtySold: number;
  /** Phase 6.3 (2026-05-13) — STOCK qty sold = sales of the specific
   *  `fulfilledProductId` values the buyer drafted on this Buy.
   *  Drives status hints (underbuy / healthy / etc.) since these
   *  are the units that came off the buyer's planned shelf. */
  qtyStockSold: number;
  /** Phase 6.3 — SPECIAL qty sold = sales of OTHER variants of the
   *  same frame (customer-spec custom orders). Doesn't consume
   *  shelf inventory; informational only — doesn't drive status. */
  qtySpecialSold: number;
  /** Σ qty × cost across the drafts. Cost basis from the buyer's drafts. */
  totalCost: number;
  /** Σ netPrice (already line-total per CLAUDE.md gotcha) across sales lines. */
  revenue: number;
  /** Phase 6.11 (2026-05-14) — revenue from STOCK sales only (sales
   *  of the buyer's drafted products). The "did MY plan generate
   *  revenue?" subset. */
  stockRevenue: number;
  /** Phase 6.11 — revenue from SPECIAL sales (other frame-mate
   *  variants — customer-spec custom orders). Often higher unit
   *  prices, often lower margins. Informational. */
  specialRevenue: number;
  /** Cost basis for the SOLD units only. Used for margin math.
   *  Uses line.cost when present, else the draft's cost-per-unit × line.qty. */
  costOfSold: number;
  /** Phase 6.11 — costOfSold restricted to STOCK lines. */
  stockCostOfSold: number;
  /** Phase 6.11 — costOfSold restricted to SPECIAL lines. */
  specialCostOfSold: number;
  /** revenue - costOfSold, never less than 0 (clamped — protects display). */
  grossProfit: number;
  /** grossProfit / revenue as a fraction. 0 when revenue is 0. */
  marginRatio: number;
  /** Phase 6.11 — margin from stock sales only.
   *  (stockRevenue - stockCostOfSold) / stockRevenue. The buyer's
   *  "did my plan work financially?" answer, isolated from
   *  customer-spec special-order math. */
  stockMarginRatio: number;
  /** Phase 6.11 — margin from special sales only. */
  specialMarginRatio: number;
  /** qtySold / qtyOrdered. 0 when nothing was ordered. >1 means underbuy.
   *  Combined across stock + special — use `stockSellThroughRatio`
   *  for the buyer's "did my plan work?" view. */
  sellThroughRatio: number;
  /** qtyStockSold / qtyOrdered. The status-driving metric. */
  stockSellThroughRatio: number;
  /** Status hint for the row badge. See thresholds below. */
  status: PerformanceStatus;
  /** Count of distinct drafts that rolled into this frame (so the UI can show
   *  "3 drafts for this frame" when grade variants were drafted separately). */
  draftCount: number;
  /** True when at least one draft was auto-linked. Without a link we can't
   *  attribute sales — surface the gap in the UI rather than report 0. */
  hasAnyLink: boolean;
  /** True when one or more sold line items had no usable cost (null or
   *  0) and we fell back to `revenue / 2` (industry-baseline 50% margin
   *  assumption). UI should mark the cost/margin columns with "(est)"
   *  so the buyer knows the numbers are inferred, not measured. */
  hasEstimatedCost: boolean;
}

export type PerformanceStatus =
  | "no-link" // No draft on this frame has a fulfilledProductId yet
  | "dead" // Linked, but zero sales after 60+ days (caller-provided window)
  | "underbuy" // Sold more than ordered — re-order suggestion
  | "healthy" // Sold 60-100% of ordered — repeat
  | "soft" // Sold <60% of ordered, but not dead
  | "pending"; // Linked < 60 days ago, too early to judge

/** Sell-through thresholds for the status hint. Tuned for furniture
 *  buying — apparel / fast-moving goods would want different bands. */
export const STATUS_THRESHOLDS = {
  underbuyAt: 1, // sellThroughRatio > 1 = sold more than ordered
  healthyMin: 0.6, // 0.6 <= ratio <= 1 = healthy
  // ratio < 0.6 = soft, unless zero AND past the dead window (then "dead")
} as const;

export interface ComputePerformanceOptions {
  /** Days since the Buy was created. Used to decide whether 0 sales is
   *  "too early" (pending) vs "dead". */
  daysSinceBuyExported: number;
  /** Window after which 0 sales = "dead". Default 60d for furniture. */
  deadAfterDays?: number;
  /** Phase 6.3 (2026-05-13) — the set of `Product.id` values the buyer
   *  drafted on this Buy (collected from each draft's `fulfilledProductId`
   *  where set). Sales of these products count as STOCK sold; sales of
   *  other frame-mate products count as SPECIAL orders. Status hints
   *  (underbuy / healthy / soft) compute against STOCK sold only,
   *  because special orders don't consume the buyer's shelf inventory.
   *
   *  When `undefined`, falls back to all-sales-as-stock for backward
   *  compatibility (the pre-split behavior). */
  stockProductIds?: ReadonlySet<number>;
  /** Phase 6.8.1 (2026-05-14) — per-frame sales window. Maps frameKey
   *  to the earliest date the frame was received (on a linked real
   *  PO). Sales of products in this frame are folded into the bucket
   *  ONLY if their orderDate ≥ that date.
   *
   *  Buyer feedback: "the sales should be from when ever the item
   *  gets received from the PO if possible." Per-frame precision is
   *  more accurate than a single buy-wide window — a Hooker frame
   *  that arrived Oct 2025 has different "available to sell" dates
   *  than a CRL frame that arrived Feb 2026.
   *
   *  Frames not in the map fall back to "no per-frame filter"
   *  (caller's responsibility to also gate by the buy-wide sales
   *  window in the SQL query). Sale lines with `orderDate === null`
   *  are excluded when their frame is in the map. */
  frameWindowStartByKey?: ReadonlyMap<string, Date>;
}

/**
 * Aggregate drafts + sales by frame and produce the per-frame metrics
 * the report renders. Pure — no DB, no Date.now() (caller supplies
 * `daysSinceBuyExported`).
 *
 * The sales array is FILTERED + AGGREGATED upstream: caller passes
 * only the OrderLineItem rows where `productId IN <frame mates>` and
 * `lineItemStatus != 'CANCELLED'` (rule 33) and order status isn't
 * CANCELLED.
 */
export function computePerformance(
  drafts: readonly PerformanceDraft[],
  sales: readonly PerformanceSaleLine[],
  productToFrame: ProductFrameIndex,
  options: ComputePerformanceOptions,
  receipts: readonly PerformanceReceiptLine[] = [],
): FramePerformance[] {
  const deadAfterDays = options.deadAfterDays ?? 60;
  const buckets = new Map<string, FrameBucket>();

  foldDraftsIntoBuckets(drafts, buckets);
  foldReceiptsIntoBuckets(receipts, productToFrame, buckets, options.stockProductIds);
  foldSalesIntoBuckets(
    sales,
    productToFrame,
    buckets,
    options.stockProductIds,
    options.frameWindowStartByKey,
  );

  const results: FramePerformance[] = [];
  for (const [frameKey, b] of buckets) {
    results.push(finalizeBucket(frameKey, b, options.daysSinceBuyExported, deadAfterDays));
  }

  // Sort by revenue descending — top performers first
  results.sort((a, b) => b.revenue - a.revenue);
  return results;
}

// ─── Internals ─────────────────────────────────────────────────────────

interface FrameBucket {
  frameLabel: string;
  qtyOrdered: number;
  qtyReceived: number;
  qtyStockReceived: number;
  qtySpecialReceived: number;
  qtySold: number;
  qtyStockSold: number;
  qtySpecialSold: number;
  totalCost: number;
  revenue: number;
  stockRevenue: number;
  specialRevenue: number;
  costOfSold: number;
  stockCostOfSold: number;
  specialCostOfSold: number;
  draftCount: number;
  hasAnyLink: boolean;
  /** Set true when any sold line's cost was missing/zero and we fell
   *  back to `revenue / 2`. Propagated to FramePerformance.hasEstimatedCost. */
  hasEstimatedCost: boolean;
  avgDraftCostPerUnit: number;
}

function foldDraftsIntoBuckets(
  drafts: readonly PerformanceDraft[],
  buckets: Map<string, FrameBucket>,
): void {
  for (const d of drafts) {
    if (!d.frameKey) continue; // can't aggregate a draft with no frame
    const b = ensureBucket(buckets, d.frameKey, d.frameLabel);
    b.qtyOrdered += d.qty;
    b.totalCost += d.qty * d.costPerUnit;
    b.draftCount += 1;
    if (d.fulfilledProductId !== null) b.hasAnyLink = true;
    b.avgDraftCostPerUnit = b.qtyOrdered === 0 ? 0 : b.totalCost / b.qtyOrdered;
  }
}

// Phase 6.8 — fold ReceivingRecord rows (one per receipt) into the
// per-frame buckets. Uses the same stock-vs-special split rule as
// sales: stock = drafted products, special = other frame variants
// arriving via piggyback customer orders on the same PON.
function foldReceiptsIntoBuckets(
  receipts: readonly PerformanceReceiptLine[],
  productToFrame: ProductFrameIndex,
  buckets: Map<string, FrameBucket>,
  stockProductIds: ReadonlySet<number> | undefined,
): void {
  for (const r of receipts) {
    const frameKey = productToFrame.get(r.productId);
    if (!frameKey) continue;
    const b = buckets.get(frameKey);
    if (!b) continue;
    b.qtyReceived += r.qty;
    const isStock = stockProductIds === undefined ? true : stockProductIds.has(r.productId);
    if (isStock) {
      b.qtyStockReceived += r.qty;
    } else {
      b.qtySpecialReceived += r.qty;
    }
  }
}

function foldSalesIntoBuckets(
  sales: readonly PerformanceSaleLine[],
  productToFrame: ProductFrameIndex,
  buckets: Map<string, FrameBucket>,
  stockProductIds: ReadonlySet<number> | undefined,
  frameWindowStartByKey: ReadonlyMap<string, Date> | undefined,
): void {
  for (const s of sales) {
    const frameKey = productToFrame.get(s.productId);
    if (!frameKey) continue;
    const b = buckets.get(frameKey);
    if (!b) continue;
    // Phase 6.8.1 — per-frame sales window. Skip when this frame has
    // a receivedDate floor and the sale fell before it (or has no
    // orderDate to compare). Frames absent from the map fall through
    // (no per-frame filter applied — caller's buy-wide window holds).
    if (!isSaleInFrameWindow(s, frameKey, frameWindowStartByKey)) continue;
    const isStockSale = stockProductIds === undefined ? true : stockProductIds.has(s.productId);
    foldSaleIntoBucket(s, b, isStockSale);
  }
}

// Phase 6.8.1 — pure window check. Extracted so the fold loop stays
// readable and so the rule is easy to unit-test in isolation.
function isSaleInFrameWindow(
  s: PerformanceSaleLine,
  frameKey: string,
  frameWindowStartByKey: ReadonlyMap<string, Date> | undefined,
): boolean {
  if (frameWindowStartByKey === undefined) return true;
  const windowStart = frameWindowStartByKey.get(frameKey);
  if (windowStart === undefined) return true;
  if (s.orderDate === null || s.orderDate === undefined) return false;
  return s.orderDate >= windowStart;
}

// Phase 6.3/6.11 — fold a single sale into the bucket totals,
// updating both the combined and the stock/special split numbers.
// Extracted from `foldSalesIntoBuckets` to keep cognitive complexity
// in check after the split-margin work.
function foldSaleIntoBucket(s: PerformanceSaleLine, b: FrameBucket, isStockSale: boolean): void {
  b.qtySold += s.qty;
  b.revenue += s.netPrice;
  if (isStockSale) {
    b.qtyStockSold += s.qty;
    b.stockRevenue += s.netPrice;
  } else {
    b.qtySpecialSold += s.qty;
    b.specialRevenue += s.netPrice;
  }
  // Cost fallback for the "nothing is free" data-quality case
  // surfaced 2026-05-13. Some OrderLineItems have cost stored as 0
  // (literal zero, not null) — the previous `??` fallback missed
  // and produced 100% margin. User direction: use `revenue / 2`
  // (industry-baseline 50% margin) and mark the row as estimated.
  const hasRealCost = s.cost !== null && s.cost !== undefined && s.cost > 0;
  const lineCost = hasRealCost ? (s.cost as number) : s.netPrice / 2;
  b.costOfSold += lineCost;
  if (isStockSale) {
    b.stockCostOfSold += lineCost;
  } else {
    b.specialCostOfSold += lineCost;
  }
  if (!hasRealCost) b.hasEstimatedCost = true;
}

function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

function marginOf(revenue: number, costOfSold: number): number {
  return safeDiv(Math.max(0, revenue - costOfSold), revenue);
}

function finalizeBucket(
  frameKey: string,
  b: FrameBucket,
  daysSinceBuyExported: number,
  deadAfterDays: number,
): FramePerformance {
  const sellThrough = safeDiv(b.qtySold, b.qtyOrdered);
  // Phase 6.3 — status drives off STOCK sell-through, not total.
  // Special orders don't consume shelf inventory, so they shouldn't
  // trigger "underbuy" or move the dial on "healthy/soft/dead".
  const stockSellThrough = safeDiv(b.qtyStockSold, b.qtyOrdered);
  const grossProfit = Math.max(0, b.revenue - b.costOfSold);
  const margin = marginOf(b.revenue, b.costOfSold);
  // Phase 6.11 — split margins so the buyer can isolate STOCK
  // performance (the plan they own) from SPECIAL performance
  // (informational; pulled in by piggyback customer orders).
  const stockMargin = marginOf(b.stockRevenue, b.stockCostOfSold);
  const specialMargin = marginOf(b.specialRevenue, b.specialCostOfSold);
  const status = computeStatus(b, stockSellThrough, daysSinceBuyExported, deadAfterDays);
  return {
    frameKey,
    frameLabel: b.frameLabel,
    qtyOrdered: b.qtyOrdered,
    qtyReceived: b.qtyReceived,
    qtyStockReceived: b.qtyStockReceived,
    qtySpecialReceived: b.qtySpecialReceived,
    qtySold: b.qtySold,
    qtyStockSold: b.qtyStockSold,
    qtySpecialSold: b.qtySpecialSold,
    totalCost: b.totalCost,
    revenue: b.revenue,
    stockRevenue: b.stockRevenue,
    specialRevenue: b.specialRevenue,
    costOfSold: b.costOfSold,
    stockCostOfSold: b.stockCostOfSold,
    specialCostOfSold: b.specialCostOfSold,
    grossProfit,
    marginRatio: margin,
    stockMarginRatio: stockMargin,
    specialMarginRatio: specialMargin,
    sellThroughRatio: sellThrough,
    stockSellThroughRatio: stockSellThrough,
    status,
    draftCount: b.draftCount,
    hasAnyLink: b.hasAnyLink,
    hasEstimatedCost: b.hasEstimatedCost,
  };
}

function ensureBucket(map: Map<string, FrameBucket>, key: string, label: string): FrameBucket {
  let b = map.get(key);
  if (!b) {
    b = {
      frameLabel: label,
      qtyOrdered: 0,
      qtyReceived: 0,
      qtyStockReceived: 0,
      qtySpecialReceived: 0,
      qtySold: 0,
      qtyStockSold: 0,
      qtySpecialSold: 0,
      totalCost: 0,
      revenue: 0,
      stockRevenue: 0,
      specialRevenue: 0,
      costOfSold: 0,
      stockCostOfSold: 0,
      specialCostOfSold: 0,
      draftCount: 0,
      hasAnyLink: false,
      hasEstimatedCost: false,
      avgDraftCostPerUnit: 0,
    };
    map.set(key, b);
  }
  return b;
}

function computeStatus(
  b: FrameBucket,
  stockSellThrough: number,
  daysSinceBuyExported: number,
  deadAfterDays: number,
): PerformanceStatus {
  if (!b.hasAnyLink) return "no-link";
  // Phase 6.3: dead/pending decision uses STOCK sold, not total.
  // If the buyer's specific drafted products haven't moved, the
  // stock plan didn't work — even if other variants are selling as
  // special orders. The qtySpecialSold column shows the buyer that
  // the frame IS moving (just not the variant they stocked).
  if (b.qtyStockSold === 0) {
    return daysSinceBuyExported >= deadAfterDays ? "dead" : "pending";
  }
  if (stockSellThrough > STATUS_THRESHOLDS.underbuyAt) return "underbuy";
  if (stockSellThrough >= STATUS_THRESHOLDS.healthyMin) return "healthy";
  return "soft";
}
