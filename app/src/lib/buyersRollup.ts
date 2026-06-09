// /app/src/lib/buyersRollup.ts
//
// Pure aggregation for the Buyers Report at /reports/buyers. Takes a flat
// list of per-product facts (on-hand + on-order + sold in date range) and
// rolls up into a 5-level tree:
//   - pivot=department : Department -> Category -> Type -> Vendor -> Part #
//   - pivot=vendor     : Vendor -> Department -> Category -> Type -> Part #
//
// No database access here. The API endpoint fetches facts via parallel
// queries, merges them, and calls buildBuyersRollup(). Split out so we
// can unit-test the math (sell-through, weeks supply, NULL bucketing,
// deep rollup math) without Prisma mocks.
//
// Derived metrics live at every node:
//   - sellThroughPct: soldQty / (soldQty + onHand + onOrder), 1 decimal
//   - weeksSupply:    onHand / (soldQty / weeksInRange), null if no velocity
//   - avgMarginPct:   (soldTotal - soldCost) / soldTotal, null if not sold
//   - costEstimated:  true if any contributing fact used the retail/2 cost fallback

export type BuyersPivot = "department" | "vendor";

export interface ProductFact {
  productId: number;
  productNumber: string | null;
  productName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  typeId: number | null;
  typeName: string | null;
  vendorId: number | null;
  vendorName: string | null;
  onHand: number;
  // customerStock is physical inventory sitting in the warehouse that is
  // already allocated to a customer's order (`InventoryPosition.salesOrderId
  // IS NOT NULL`). Not "available to sell" -- surfaced separately so
  // buyers can still use it as a signal ("3 customer-allocated but 0 on
  // the floor = keep a sample").
  customerStock: number;
  onOrder: number;
  soldQty: number;
  soldTotal: number;
  // Stock vs Special split: "stock" lines came from a PO not allocated to a
  // customer order (bought-for-floor, resold); "special" lines came from a
  // PO allocated to a specific customer order OR from a line item with no
  // PO link at all (typical for direct special-orders). Signal meaning is
  // inverted per department type -- high Special on Furniture is normal
  // (frame is selling); high Special on Home Acc is an emerging-trend
  // flag (customers asking for something we don't stock deep enough).
  stockSoldQty: number;
  stockSoldTotal: number;
  specialSoldQty: number;
  specialSoldTotal: number;
  // soldCost is the merchant cost side of soldTotal. the POS populates
  // OrderLineItem.cost and Product.baseCost inconsistently -- the SQL layer
  // applies a waterfall: li.cost -> p.baseCost * qty -> netPrice / 2. When
  // the retail/2 fallback kicks in for any of the product's lines,
  // costEstimated is true so the UI can flag the margin number.
  soldCost: number;
  costEstimated: boolean;
  lastSold: Date | null;
}

export interface BuyersNode {
  id: string;
  name: string;
  // Leaf-only: the underlying Product.id so the UI can link to /products/[id].
  // null for non-leaf group/category/vendor rows.
  productId: number | null;
  productCount: number;
  onHand: number;
  customerStock: number;
  onOrder: number;
  soldQty: number;
  soldTotal: number;
  stockSoldQty: number;
  stockSoldTotal: number;
  specialSoldQty: number;
  specialSoldTotal: number;
  soldCost: number;
  avgMarginPct: number | null;
  costEstimated: boolean;
  sellThroughPct: number;
  weeksSupply: number | null;
  lastSold: string | null;
  children: BuyersNode[];
}

export interface BuyersRollupResult {
  weeksInRange: number;
  pivot: BuyersPivot;
  totals: {
    productCount: number;
    onHand: number;
    customerStock: number;
    onOrder: number;
    soldQty: number;
    soldTotal: number;
    soldCost: number;
    avgMarginPct: number | null;
    costEstimated: boolean;
  };
  groups: BuyersNode[];
}

const UNCATEGORIZED_KEY = 0;
const UNCATEGORIZED_LABEL = "(unassigned)";

// The ordered list of pivot "axes" each fact walks through to reach a leaf.
// Each axis contributes one level in the resulting tree. The last axis is
// always the product itself.
interface PivotAxis {
  id: number | null;
  name: string | null;
  prefix: string;
}

// Stable numeric hash of an arbitrary string key. Used so frame keys
// (which are strings like "100:WH-SE-F21") can live in an accumulator
// map keyed by number (existing infra).
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pivotPath(
  pivot: BuyersPivot,
  f: ProductFact,
  frameDecisions: Map<number, { frameKey: string; frameLabel: string }> | undefined,
): PivotAxis[] {
  const productLabel =
    f.productNumber && f.productName
      ? `${f.productNumber} — ${f.productName}`
      : (f.productNumber ?? f.productName ?? null);
  // When frame rollup is active, the leaf axis uses the frame key/label
  // so sibling products that collapse to the same frame merge into one
  // leaf cell. Otherwise the leaf is per-product as before.
  const frame = frameDecisions?.get(f.productId);
  const leafAxis: PivotAxis = frame
    ? { id: stableHash(frame.frameKey), name: frame.frameLabel, prefix: "frame" }
    : { id: f.productId, name: productLabel, prefix: "part" };
  if (pivot === "department") {
    return [
      { id: f.departmentId, name: f.departmentName, prefix: "dept" },
      { id: f.categoryId, name: f.categoryName, prefix: "cat" },
      { id: f.typeId, name: f.typeName, prefix: "type" },
      { id: f.vendorId, name: f.vendorName, prefix: "vendor" },
      leafAxis,
    ];
  }
  return [
    { id: f.vendorId, name: f.vendorName, prefix: "vendor" },
    { id: f.departmentId, name: f.departmentName, prefix: "dept" },
    { id: f.categoryId, name: f.categoryName, prefix: "cat" },
    { id: f.typeId, name: f.typeName, prefix: "type" },
    leafAxis,
  ];
}

interface AccumulatorCell {
  id: number;
  name: string;
  prefix: string;
  isLeaf: boolean;
  productId: number | null;
  productCount: number;
  onHand: number;
  customerStock: number;
  onOrder: number;
  soldQty: number;
  soldTotal: number;
  stockSoldQty: number;
  stockSoldTotal: number;
  specialSoldQty: number;
  specialSoldTotal: number;
  soldCost: number;
  costEstimated: boolean;
  lastSold: Date | null;
  children: Map<number, AccumulatorCell>;
}

// Frame-leaf cells aggregate multiple distinct productIds (unlike part-
// leaves). We carry a Set so productCount is the count of distinct
// products under the frame, not the number of contributing facts.
function ensureCell(
  map: Map<number, AccumulatorCell>,
  axis: PivotAxis,
  isLeaf: boolean,
): AccumulatorCell {
  const key = axis.id ?? UNCATEGORIZED_KEY;
  let cell = map.get(key);
  if (!cell) {
    cell = {
      id: key,
      name: axis.name ?? UNCATEGORIZED_LABEL,
      prefix: axis.prefix,
      isLeaf,
      // productId is populated only for real single-product leaves
      // ("part" axis). Frame-leaves (multiple products collapsed) have
      // productId null so the UI doesn't try to navigate to a synthetic
      // hash-based id.
      productId: isLeaf && axis.prefix === "part" ? axis.id : null,
      productCount: 0,
      onHand: 0,
      customerStock: 0,
      onOrder: 0,
      soldQty: 0,
      soldTotal: 0,
      stockSoldQty: 0,
      stockSoldTotal: 0,
      specialSoldQty: 0,
      specialSoldTotal: 0,
      soldCost: 0,
      costEstimated: false,
      lastSold: null,
      children: new Map(),
    };
    map.set(key, cell);
  }
  return cell;
}

function accumulate(into: AccumulatorCell, fact: ProductFact) {
  // Each fact represents one distinct product. Every cell the fact
  // passes through increments by 1 -- so productCount at non-leaves =
  // distinct products in the subtree, at part-leaves always = 1, and at
  // frame-leaves = number of product variants collapsed into the frame.
  into.productCount += 1;
  into.onHand += fact.onHand;
  into.customerStock += fact.customerStock;
  into.onOrder += fact.onOrder;
  into.soldQty += fact.soldQty;
  into.soldTotal += fact.soldTotal;
  into.stockSoldQty += fact.stockSoldQty;
  into.stockSoldTotal += fact.stockSoldTotal;
  into.specialSoldQty += fact.specialSoldQty;
  into.specialSoldTotal += fact.specialSoldTotal;
  into.soldCost += fact.soldCost;
  if (fact.costEstimated) into.costEstimated = true;
  if (fact.lastSold && (!into.lastSold || fact.lastSold > into.lastSold)) {
    into.lastSold = fact.lastSold;
  }
}

function marginPct(soldTotal: number, soldCost: number): number | null {
  if (soldTotal <= 0) return null;
  return Math.round(((soldTotal - soldCost) / soldTotal) * 1000) / 10;
}

function sellThroughPct(soldQty: number, onHand: number, onOrder: number): number {
  const denom = soldQty + Math.max(onHand, 0) + Math.max(onOrder, 0);
  if (denom <= 0) return 0;
  return Math.round((soldQty / denom) * 1000) / 10;
}

function weeksSupply(onHand: number, soldQty: number, weeksInRange: number): number | null {
  if (weeksInRange <= 0 || soldQty <= 0 || onHand <= 0) return null;
  const velocityPerWeek = soldQty / weeksInRange;
  if (velocityPerWeek <= 0) return null;
  return Math.round((onHand / velocityPerWeek) * 10) / 10;
}

function cellToNode(cell: AccumulatorCell, weeksInRange: number): BuyersNode {
  const children = Array.from(cell.children.values())
    .map((c) => cellToNode(c, weeksInRange))
    .sort((a, b) => b.soldTotal - a.soldTotal);
  return {
    id: `${cell.prefix}:${cell.id}`,
    name: cell.name,
    productId: cell.productId,
    productCount: cell.productCount,
    onHand: cell.onHand,
    customerStock: cell.customerStock,
    onOrder: cell.onOrder,
    soldQty: cell.soldQty,
    soldTotal: Math.round(cell.soldTotal * 100) / 100,
    stockSoldQty: cell.stockSoldQty,
    stockSoldTotal: Math.round(cell.stockSoldTotal * 100) / 100,
    specialSoldQty: cell.specialSoldQty,
    specialSoldTotal: Math.round(cell.specialSoldTotal * 100) / 100,
    soldCost: Math.round(cell.soldCost * 100) / 100,
    avgMarginPct: marginPct(cell.soldTotal, cell.soldCost),
    costEstimated: cell.costEstimated,
    sellThroughPct: sellThroughPct(cell.soldQty, cell.onHand, cell.onOrder),
    weeksSupply: weeksSupply(cell.onHand, cell.soldQty, weeksInRange),
    lastSold: cell.lastSold ? cell.lastSold.toISOString() : null,
    children,
  };
}

export function buildBuyersRollup(
  facts: ProductFact[],
  pivot: BuyersPivot,
  weeksInRange: number,
  frameDecisions?: Map<number, { frameKey: string; frameLabel: string }>,
): BuyersRollupResult {
  const roots = new Map<number, AccumulatorCell>();

  for (const f of facts) {
    const path = pivotPath(pivot, f, frameDecisions);
    let siblings = roots;
    for (let i = 0; i < path.length; i++) {
      const isLeaf = i === path.length - 1;
      const cell = ensureCell(siblings, path[i], isLeaf);
      accumulate(cell, f);
      siblings = cell.children;
    }
  }

  const nodes = Array.from(roots.values())
    .map((r) => cellToNode(r, weeksInRange))
    .sort((a, b) => b.soldTotal - a.soldTotal);

  const totals = nodes.reduce(
    (acc, n) => {
      acc.productCount += n.productCount;
      acc.onHand += n.onHand;
      acc.customerStock += n.customerStock;
      acc.onOrder += n.onOrder;
      acc.soldQty += n.soldQty;
      acc.soldTotal += n.soldTotal;
      acc.soldCost += n.soldCost;
      if (n.costEstimated) acc.costEstimated = true;
      return acc;
    },
    {
      productCount: 0,
      onHand: 0,
      customerStock: 0,
      onOrder: 0,
      soldQty: 0,
      soldTotal: 0,
      soldCost: 0,
      costEstimated: false,
    },
  );

  return {
    weeksInRange,
    pivot,
    totals: {
      ...totals,
      soldTotal: Math.round(totals.soldTotal * 100) / 100,
      soldCost: Math.round(totals.soldCost * 100) / 100,
      avgMarginPct: marginPct(totals.soldTotal, totals.soldCost),
    },
    groups: nodes,
  };
}

// Flatten a node's leaves (no children) into an array. A leaf may be a
// real product (productId set) or a rolled-up frame (productId null,
// productCount = number of collapsed variants).
export function flattenLeaves(node: BuyersNode): BuyersNode[] {
  if (node.children.length === 0) return [node];
  const out: BuyersNode[] = [];
  for (const c of node.children) out.push(...flattenLeaves(c));
  return out;
}
