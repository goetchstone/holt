// /app/src/lib/reports/salesExplorerPivot.ts
//
// Pure, client-safe pivot-tree builder for the Sales Explorer report. Ported
// from furniture-configurator's lib/salesExplorerPivot.ts (same shape:
// re-nest a flat `store|dept|cat|vendor` cell map into a drill-down tree
// along a chosen axis, with Current + Compare totals and variance at every
// node) but re-typed against holt's own cell contract instead of importing
// FC's SQL or its detailedSalesCompare.ts helpers, which holt doesn't have.
//
// No I/O here — the three reporting invariants (CLAUDE.md rule 33 cancelled-
// line exclusion, the nullable-column NULL trap, and netPrice-as-line-total)
// all live in salesExplorerQuery.ts, which produces the cell maps this file
// consumes. This file only re-shapes and sums, so it's cheap to exhaustively
// unit test (see __tests__/salesExplorerPivot.test.ts) without a database.
//
// Cell contract: one bucket per (store, department, category, vendor) for a
// SINGLE period, keyed `${store}|${department}|${category}|${vendor}` —
// mirrors holt's own lib/reports/detailedSales.ts row shape (store/dept/
// category/vendor + netSales/itemCount), with `cost` added so the explorer
// can show margin% the way lib/reports/grossMargin.ts and marginMath.ts do
// elsewhere in the codebase. Two of these maps (one per period) are merged
// here into one tree per pivot axis.
//
// Bucket fallback names ("Uncategorized" / "(No Category)" / "Unknown
// Vendor") intentionally match the literals lib/reports/detailedSales.ts
// already uses for the same fallback ("Uncategorized" department, "Unknown
// Vendor") so the same orphan line items read identically across both
// reports. Per schema.prisma, `Product.departmentId` / `categoryId` /
// `vendorId` are all NON-nullable columns — a real product can never be
// missing just one of department/category/vendor. So these three fallbacks
// can only ever appear TOGETHER, from a line item with NO product at all
// (`OrderLineItem.productId IS NULL`). salesExplorerQuery.ts's drilldown
// relies on that fact to normalize any of the three sentinels back to the
// single "Uncategorized" orphan case. `storeLocation` IS nullable
// (`SalesOrder.storeLocation String?`) and falls back to the literal
// "Unknown" — same fallback name comparativeSales.ts and detailedSales.ts
// both use, kept visible here (not dropped) so a node's Current/Compare
// totals always equal the sum of every line item in range, with nothing
// silently excluded.

export const SALES_EXPLORER_PIVOTS = ["store", "department", "category", "vendor"] as const;
export type SalesExplorerPivot = (typeof SALES_EXPLORER_PIVOTS)[number];

/** The four dimensions carried in a cell key, in split order. */
export type SalesExplorerDimension = "storeLocation" | "department" | "category" | "vendor";

export const UNCATEGORIZED_DEPARTMENT = "Uncategorized";
export const NO_CATEGORY_LABEL = "(No Category)";
export const UNKNOWN_VENDOR_LABEL = "Unknown Vendor";
export const UNKNOWN_STORE_LABEL = "Unknown";

/**
 * Drill-down axis per pivot. The first entry is the top-level row; each
 * further entry is one expand level. Store only ever appears at the top of
 * the Store pivot (traffic/conversion attach there); Category and Vendor
 * pivots deliberately omit `department` from their axis — a category or
 * vendor is rolled up across every department it appears in, by design.
 */
const PIVOT_AXES: Record<SalesExplorerPivot, SalesExplorerDimension[]> = {
  store: ["storeLocation", "department", "category", "vendor"],
  department: ["department", "category", "vendor"],
  category: ["category", "vendor"],
  vendor: ["vendor", "department", "category"],
};

/** One (store, department, category, vendor) bucket's totals for a SINGLE
 *  period, as produced by salesExplorerQuery.ts. */
export interface SalesExplorerCell {
  netSales: number;
  cost: number;
  itemCount: number;
}

export type SalesExplorerCellMap = Record<string, SalesExplorerCell>;

/** Splits a `store|dept|cat|vendor` cell key back into its four dimensions. */
export function splitCellKey(key: string): {
  storeLocation: string;
  department: string;
  category: string;
  vendor: string;
} {
  const [storeLocation, department, category, vendor] = key.split("|");
  return { storeLocation, department, category, vendor };
}

export interface PeriodAgg {
  netSales: number;
  cost: number;
  itemCount: number;
  /** Distinct order count — attached only at store nodes (an order spans depts). */
  orderCount?: number;
  /** Store door-counter visitors — attached only at store nodes. */
  visitors?: number;
}

export interface SalesExplorerNode {
  /** Stable path id (dimension display names joined by `||`) — React key,
   *  expand state, AND the input to resolveNodeFilters() for drilldown. */
  id: string;
  name: string;
  level: SalesExplorerDimension;
  period1: PeriodAgg;
  period2: PeriodAgg;
  /** period1.netSales − period2.netSales. */
  variance: number;
  /** Fraction (0.25 = +25%); null when the compare period sold nothing. */
  variancePct: number | null;
  marginPct1: number | null;
  marginPct2: number | null;
  /** Store nodes only: orderCount / visitors, null when visitors is 0. */
  conversion1?: number | null;
  conversion2?: number | null;
  children: SalesExplorerNode[];
}

export interface SalesExplorerTotals {
  period1: PeriodAgg;
  period2: PeriodAgg;
  variance: number;
  variancePct: number | null;
}

/** Per-store order counts + visitors for both periods (store nodes + the
 *  traffic panel). */
export interface StorePeriodMeta {
  orderCount1: number;
  orderCount2: number;
  visitors1: number;
  visitors2: number;
}

/** One store's traffic + conversion for both periods (the Store Traffic panel). */
export interface StoreTrafficRow {
  store: string;
  visitors1: number;
  visitors2: number;
  orderCount1: number;
  orderCount2: number;
  conversion1: number | null;
  conversion2: number | null;
}

interface MutableNode {
  id: string;
  name: string;
  level: SalesExplorerDimension;
  p1: PeriodAgg;
  p2: PeriodAgg;
  children: Map<string, MutableNode>;
}

function emptyAgg(): PeriodAgg {
  return { netSales: 0, cost: 0, itemCount: 0 };
}

/** Blank category cells (a product with a department but no category) read as
 *  "(No Category)" so a drill-down never shows an empty row. */
function displayName(dim: SalesExplorerDimension, raw: string): string {
  if (dim === "category" && raw.trim() === "") return NO_CATEGORY_LABEL;
  return raw;
}

function accumulate(agg: PeriodAgg, cell: SalesExplorerCell): void {
  agg.netSales += cell.netSales;
  agg.cost += cell.cost;
  agg.itemCount += cell.itemCount;
}

// Percent change of current vs prior, as a fraction (0.25 = +25%). Returns
// null when prior is 0 so the UI can render an em dash instead of a
// misleading Infinity/NaN.
export function variancePct(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return (current - prior) / prior;
}

function marginPct(agg: PeriodAgg): number | null {
  if (agg.netSales === 0) return null;
  return (agg.netSales - agg.cost) / agg.netSales;
}

function conversion(orderCount: number, visitors: number): number | null {
  if (visitors <= 0) return null;
  return orderCount / visitors;
}

/**
 * Add every cell of one period into the shared tree, rolling each cell's
 * totals into every ancestor along its axis path.
 */
function addPeriod(
  roots: Map<string, MutableNode>,
  cells: SalesExplorerCellMap,
  axis: SalesExplorerDimension[],
  period: "p1" | "p2",
): void {
  for (const [key, cell] of Object.entries(cells)) {
    const dims = splitCellKey(key);
    let level = roots;
    let pathId = "";
    for (const dim of axis) {
      const name = displayName(dim, dims[dim]);
      pathId = pathId ? `${pathId}||${name}` : name;
      let node = level.get(name);
      if (!node) {
        node = {
          id: pathId,
          name,
          level: dim,
          p1: emptyAgg(),
          p2: emptyAgg(),
          children: new Map(),
        };
        level.set(name, node);
      }
      accumulate(node[period], cell);
      level = node.children;
    }
  }
}

function finalize(
  node: MutableNode,
  storeMeta?: Record<string, StorePeriodMeta>,
): SalesExplorerNode {
  const period1: PeriodAgg = { ...node.p1 };
  const period2: PeriodAgg = { ...node.p2 };
  let conversion1: number | null | undefined;
  let conversion2: number | null | undefined;

  // Order counts, visitors and conversion are order-level and only make sense
  // at a store node — they don't sum across the departments an order spans.
  if (node.level === "storeLocation" && storeMeta) {
    const meta = storeMeta[node.name];
    period1.orderCount = meta?.orderCount1 ?? 0;
    period2.orderCount = meta?.orderCount2 ?? 0;
    period1.visitors = meta?.visitors1 ?? 0;
    period2.visitors = meta?.visitors2 ?? 0;
    conversion1 = conversion(period1.orderCount, period1.visitors);
    conversion2 = conversion(period2.orderCount, period2.visitors);
  }

  const children = [...node.children.values()]
    .map((child) => finalize(child, storeMeta))
    .sort((a, b) => b.period1.netSales - a.period1.netSales);

  return {
    id: node.id,
    name: node.name,
    level: node.level,
    period1,
    period2,
    variance: period1.netSales - period2.netSales,
    variancePct: variancePct(period1.netSales, period2.netSales),
    marginPct1: marginPct(period1),
    marginPct2: marginPct(period2),
    ...(conversion1 !== undefined ? { conversion1, conversion2 } : {}),
    children,
  };
}

/**
 * Build the drill-down tree + grand totals for one pivot.
 *
 * `storeMeta` (optional) supplies per-store order counts and visitors; it is
 * only consumed for the Store pivot, where store nodes exist. The grand total
 * is the sum of every cell in BOTH maps and is therefore identical across all
 * four pivots (pinned in __tests__/salesExplorerPivot.test.ts) — deliberately
 * unlike comparativeSales.ts, which drops its "Unknown" store bucket
 * entirely. Sales Explorer keeps it visible (as a normal "Unknown" row under
 * the Store pivot) so the printed total always equals the sum of the visible
 * rows, with nothing silently excluded.
 */
export function buildSalesExplorerTree(
  cellsP1: SalesExplorerCellMap,
  cellsP2: SalesExplorerCellMap,
  pivot: SalesExplorerPivot,
  storeMeta?: Record<string, StorePeriodMeta>,
): { tree: SalesExplorerNode[]; totals: SalesExplorerTotals } {
  const axis = PIVOT_AXES[pivot];
  const roots = new Map<string, MutableNode>();
  addPeriod(roots, cellsP1, axis, "p1");
  addPeriod(roots, cellsP2, axis, "p2");

  const tree = [...roots.values()]
    .map((node) => finalize(node, storeMeta))
    .sort((a, b) => b.period1.netSales - a.period1.netSales);

  // Grand total = sum of the top-level rows. Every cell rolls into exactly one
  // top-level node, so this equals the sum of all cells regardless of pivot.
  const p1 = emptyAgg();
  const p2 = emptyAgg();
  for (const node of tree) {
    p1.netSales += node.period1.netSales;
    p1.cost += node.period1.cost;
    p1.itemCount += node.period1.itemCount;
    p2.netSales += node.period2.netSales;
    p2.cost += node.period2.cost;
    p2.itemCount += node.period2.itemCount;
  }
  const totals: SalesExplorerTotals = {
    period1: p1,
    period2: p2,
    variance: p1.netSales - p2.netSales,
    variancePct: variancePct(p1.netSales, p2.netSales),
  };
  return { tree, totals };
}

/** The store/department/category/vendor filters needed to drill a Sales
 *  Explorer tree node down to product-level rows for ONE period. */
export interface SalesExplorerNodeFilters {
  store?: string;
  department?: string;
  category?: string;
  vendor?: string;
}

/**
 * Reverse-maps a tree node's `id` (built by buildSalesExplorerTree, which
 * joins each axis level's display name with `||`) back into the filters
 * needed to fetch its product-level line items. Pure — no I/O — so the
 * client and the tRPC drilldown procedure resolve identical filters from
 * (pivot, nodeId) without the server trusting a client-constructed filter
 * object for anything beyond the id the tree itself produced.
 */
export function resolveNodeFilters(
  pivot: SalesExplorerPivot,
  nodeId: string,
): SalesExplorerNodeFilters {
  const axis = PIVOT_AXES[pivot];
  const segments = nodeId.split("||");
  const filters: SalesExplorerNodeFilters = {};
  segments.forEach((raw, i) => {
    const dim = axis[i];
    if (!dim) return;
    if (dim === "storeLocation") filters.store = raw;
    else filters[dim] = raw;
  });
  return filters;
}
