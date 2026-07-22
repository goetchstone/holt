// /app/__tests__/salesExplorerPivot.test.ts
//
// Pure unit tests for the Sales Explorer pivot-tree builder. No database —
// this file only re-shapes cell maps the query layer produces, so every
// branch (variance math, margin %, conversion, the four pivot axes, node id
// encoding, and the id -> filters round trip drilldown depends on) is
// exercised directly against fabricated cell maps.

import {
  buildSalesExplorerTree,
  resolveNodeFilters,
  splitCellKey,
  variancePct,
  type SalesExplorerCellMap,
} from "@/lib/reports/salesExplorerPivot";

function cell(netSales: number, cost: number, itemCount = 1) {
  return { netSales, cost, itemCount };
}

describe("splitCellKey", () => {
  it("splits a store|dept|cat|vendor key into its four dimensions", () => {
    expect(splitCellKey("Old Saybrook|Furniture|Sofas|Wesley Hall")).toEqual({
      storeLocation: "Old Saybrook",
      department: "Furniture",
      category: "Sofas",
      vendor: "Wesley Hall",
    });
  });
});

describe("variancePct", () => {
  it("returns a fraction, positive for growth", () => {
    expect(variancePct(150, 100)).toBeCloseTo(0.5);
  });
  it("returns a fraction, negative for decline", () => {
    expect(variancePct(50, 100)).toBeCloseTo(-0.5);
  });
  it("returns null when prior is 0 (no divide-by-zero)", () => {
    expect(variancePct(100, 0)).toBeNull();
  });
});

describe("buildSalesExplorerTree", () => {
  const cellsP1: SalesExplorerCellMap = {
    "Old Saybrook|Furniture|Sofas|Wesley Hall": cell(1000, 400, 2),
    "Old Saybrook|Furniture|Chairs|Wesley Hall": cell(500, 300, 1),
    "Madison|Furniture|Sofas|Vanguard": cell(200, 100, 1),
  };
  const cellsP2: SalesExplorerCellMap = {
    "Old Saybrook|Furniture|Sofas|Wesley Hall": cell(800, 320, 2),
    "Madison|Rugs|Area Rugs|Surya": cell(300, 150, 1),
  };

  it("rolls every cell into every ancestor along the store axis (store -> dept -> category -> vendor)", () => {
    const { tree } = buildSalesExplorerTree(cellsP1, cellsP2, "store");
    const oldSaybrook = tree.find((n) => n.name === "Old Saybrook")!;
    // 1000 (Sofas) + 500 (Chairs) in period1; only the Sofas cell has a
    // period2 value (800).
    expect(oldSaybrook.period1.netSales).toBe(1500);
    expect(oldSaybrook.period2.netSales).toBe(800);
    // Store's immediate children are department-level (both cells share
    // department "Furniture"); category-level Sofas/Chairs are grandchildren.
    expect(oldSaybrook.children.map((c) => c.name)).toEqual(["Furniture"]);
    const furniture = oldSaybrook.children[0];
    expect(furniture.children.map((c) => c.name).sort()).toEqual(["Chairs", "Sofas"]);
  });

  it("union semantics: a bucket present in only one period still produces a node", () => {
    const { tree } = buildSalesExplorerTree(cellsP1, cellsP2, "store");
    const madison = tree.find((n) => n.name === "Madison")!;
    // Madison sold Furniture/Sofas in p1 only and Rugs/Area Rugs in p2 only.
    expect(madison.period1.netSales).toBe(200);
    expect(madison.period2.netSales).toBe(300);
    const rugsChild = madison.children.find((c) => c.name === "Rugs")!;
    expect(rugsChild.period1.netSales).toBe(0);
    expect(rugsChild.period2.netSales).toBe(300);
  });

  it("computes variance and variancePct at every node", () => {
    const { tree } = buildSalesExplorerTree(cellsP1, cellsP2, "store");
    const oldSaybrook = tree.find((n) => n.name === "Old Saybrook")!;
    expect(oldSaybrook.variance).toBe(700); // 1500 - 800
    expect(oldSaybrook.variancePct).toBeCloseTo(0.875); // 700 / 800
  });

  it("computes margin % per period, null when netSales is 0", () => {
    const { tree } = buildSalesExplorerTree(cellsP1, cellsP2, "store");
    const oldSaybrook = tree.find((n) => n.name === "Old Saybrook")!;
    // period1: netSales 1500, cost 400+300=700 -> margin 800/1500
    expect(oldSaybrook.marginPct1).toBeCloseTo(800 / 1500);
    const madison = tree.find((n) => n.name === "Madison")!;
    const rugsChild = madison.children.find((c) => c.name === "Rugs")!;
    expect(rugsChild.marginPct1).toBeNull(); // sold nothing in period1
  });

  it("blank category buckets display as (No Category)", () => {
    const cells: SalesExplorerCellMap = {
      "Old Saybrook|Furniture||Wesley Hall": cell(100, 50, 1),
    };
    const { tree } = buildSalesExplorerTree(cells, {}, "department");
    const furniture = tree.find((n) => n.name === "Furniture")!;
    expect(furniture.children[0].name).toBe("(No Category)");
    expect(furniture.children[0].id).toBe("Furniture||(No Category)");
  });

  it("keeps an orphan Unknown store visible (unlike comparativeSales.ts) so totals equal the sum of visible rows", () => {
    const cells: SalesExplorerCellMap = {
      "Unknown|Furniture|Sofas|Wesley Hall": cell(100, 50, 1),
      "Old Saybrook|Furniture|Sofas|Wesley Hall": cell(200, 80, 1),
    };
    const { tree, totals } = buildSalesExplorerTree(cells, {}, "store");
    expect(tree.map((n) => n.name).sort()).toEqual(["Old Saybrook", "Unknown"]);
    expect(totals.period1.netSales).toBe(300);
  });

  it("grand total is identical across all four pivots (every cell rolls into exactly one top-level node)", () => {
    const results = (["store", "department", "category", "vendor"] as const).map(
      (pivot) => buildSalesExplorerTree(cellsP1, cellsP2, pivot).totals,
    );
    for (const totals of results) {
      expect(totals.period1.netSales).toBeCloseTo(1700); // 1000+500+200
      expect(totals.period2.netSales).toBeCloseTo(1100); // 800+300
    }
  });

  it("category pivot rolls a category name up across every department it appears in", () => {
    const cells: SalesExplorerCellMap = {
      "Old Saybrook|Furniture|Accessories|VendorA": cell(100, 40, 1),
      "Old Saybrook|Home Shop|Accessories|VendorB": cell(50, 20, 1),
    };
    const { tree } = buildSalesExplorerTree(cells, {}, "category");
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Accessories");
    expect(tree[0].period1.netSales).toBe(150);
    expect(tree[0].children.map((c) => c.name).sort()).toEqual(["VendorA", "VendorB"]);
  });

  it("store nodes attach orderCount/visitors/conversion from storeMeta; non-store nodes do not", () => {
    const { tree } = buildSalesExplorerTree(cellsP1, cellsP2, "store", {
      "Old Saybrook": { orderCount1: 10, orderCount2: 8, visitors1: 100, visitors2: 80 },
    });
    const oldSaybrook = tree.find((n) => n.name === "Old Saybrook")!;
    expect(oldSaybrook.period1.orderCount).toBe(10);
    expect(oldSaybrook.conversion1).toBeCloseTo(0.1); // 10/100
    expect(oldSaybrook.children[0].conversion1).toBeUndefined();
  });

  it("a store with zero visitors gets null conversion, not a divide-by-zero", () => {
    const { tree } = buildSalesExplorerTree(cellsP1, cellsP2, "store", {
      "Old Saybrook": { orderCount1: 5, orderCount2: 0, visitors1: 0, visitors2: 0 },
    });
    const oldSaybrook = tree.find((n) => n.name === "Old Saybrook")!;
    expect(oldSaybrook.conversion1).toBeNull();
  });

  it("children are sorted by period1 net sales descending", () => {
    const { tree } = buildSalesExplorerTree(cellsP1, cellsP2, "store");
    const oldSaybrook = tree.find((n) => n.name === "Old Saybrook")!;
    const furniture = oldSaybrook.children[0];
    // Sofas (1000) outsold Chairs (500) in period1.
    expect(furniture.children.map((c) => c.name)).toEqual(["Sofas", "Chairs"]);
  });
});

describe("resolveNodeFilters", () => {
  it("resolves a top-level store node to just a store filter", () => {
    expect(resolveNodeFilters("store", "Old Saybrook")).toEqual({ store: "Old Saybrook" });
  });

  it("resolves a fully-drilled store node to all four filters, in axis order", () => {
    expect(resolveNodeFilters("store", "Old Saybrook||Furniture||Sofas||Wesley Hall")).toEqual({
      store: "Old Saybrook",
      department: "Furniture",
      category: "Sofas",
      vendor: "Wesley Hall",
    });
  });

  it("the category pivot never resolves a department filter (axis omits it)", () => {
    expect(resolveNodeFilters("category", "Accessories||VendorA")).toEqual({
      category: "Accessories",
      vendor: "VendorA",
    });
  });

  it("the vendor pivot axis order is vendor -> department -> category", () => {
    expect(resolveNodeFilters("vendor", "Wesley Hall||Furniture||Sofas")).toEqual({
      vendor: "Wesley Hall",
      department: "Furniture",
      category: "Sofas",
    });
  });

  it("round-trips through a node id containing the (No Category) sentinel", () => {
    expect(resolveNodeFilters("department", "Furniture||(No Category)||Wesley Hall")).toEqual({
      department: "Furniture",
      category: "(No Category)",
      vendor: "Wesley Hall",
    });
  });
});
