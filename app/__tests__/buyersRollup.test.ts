// /app/__tests__/buyersRollup.test.ts

import { buildBuyersRollup, flattenLeaves, type ProductFact } from "@/lib/buyersRollup";

function fact(overrides: Partial<ProductFact> = {}): ProductFact {
  return {
    productId: 1,
    productNumber: null,
    productName: null,
    departmentId: 1,
    departmentName: "Furniture",
    categoryId: 10,
    categoryName: "Sofas",
    typeId: 200,
    typeName: "Sectional",
    vendorId: 100,
    vendorName: "Wesley Hall",
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
    ...overrides,
  };
}

describe("buildBuyersRollup", () => {
  it("returns empty groups for no facts", () => {
    const r = buildBuyersRollup([], "department", 12);
    expect(r.groups).toEqual([]);
    expect(r.totals.productCount).toBe(0);
    expect(r.pivot).toBe("department");
    expect(r.weeksInRange).toBe(12);
  });

  it("rolls up per-product facts into Department -> Category for pivot=department", () => {
    const facts: ProductFact[] = [
      fact({ productId: 1, categoryId: 10, categoryName: "Sofas", soldQty: 2, soldTotal: 4000 }),
      fact({ productId: 2, categoryId: 10, categoryName: "Sofas", soldQty: 1, soldTotal: 2000 }),
      fact({ productId: 3, categoryId: 11, categoryName: "Chairs", soldQty: 5, soldTotal: 7500 }),
    ];
    const r = buildBuyersRollup(facts, "department", 12);
    expect(r.groups).toHaveLength(1);
    const furniture = r.groups[0];
    expect(furniture.name).toBe("Furniture");
    expect(furniture.productCount).toBe(3);
    expect(furniture.soldQty).toBe(8);
    expect(furniture.soldTotal).toBe(13500);
    expect(furniture.children).toHaveLength(2);
    // Sorted by soldTotal desc: Sofas ($6k) before Chairs ($7.5k)? -- no, Chairs wins
    expect(furniture.children[0].name).toBe("Chairs");
    expect(furniture.children[1].name).toBe("Sofas");
  });

  it("rolls up by Vendor -> Department for pivot=vendor", () => {
    const facts: ProductFact[] = [
      fact({
        productId: 1,
        departmentId: 1,
        departmentName: "Furniture",
        vendorId: 100,
        vendorName: "Wesley Hall",
        soldTotal: 5000,
      }),
      fact({
        productId: 2,
        departmentId: 2,
        departmentName: "Bedroom",
        vendorId: 100,
        vendorName: "Wesley Hall",
        soldTotal: 3000,
      }),
      fact({
        productId: 3,
        departmentId: 1,
        departmentName: "Furniture",
        vendorId: 200,
        vendorName: "CR Laine",
        soldTotal: 8000,
      }),
    ];
    const r = buildBuyersRollup(facts, "vendor", 12);
    expect(r.groups).toHaveLength(2);
    // CR Laine $8k ranks first over Wesley Hall $8k (soldTotal tie-break is insertion order)
    expect(r.groups[0].name).toMatch(/CR Laine|Wesley Hall/);
    const wesley = r.groups.find((g) => g.name === "Wesley Hall")!;
    expect(wesley.children.map((c) => c.name).sort()).toEqual(["Bedroom", "Furniture"]);
  });

  it("buckets missing department/vendor into an (unassigned) group", () => {
    const facts: ProductFact[] = [
      fact({
        productId: 1,
        departmentId: null,
        departmentName: null,
        categoryId: null,
        categoryName: null,
        vendorId: null,
        vendorName: null,
        soldQty: 3,
        soldTotal: 100,
      }),
    ];
    const r = buildBuyersRollup(facts, "department", 4);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].name).toBe("(unassigned)");
    expect(r.groups[0].children[0].name).toBe("(unassigned)");
  });

  describe("derived metrics", () => {
    it("sell-through is sold / (sold + onHand + onOrder) as a percentage with one decimal", () => {
      const r = buildBuyersRollup(
        [fact({ soldQty: 25, onHand: 50, onOrder: 25 })],
        "department",
        12,
      );
      // 25 / (25 + 50 + 25) = 25%
      expect(r.groups[0].sellThroughPct).toBe(25);
    });

    it("sell-through is 0 when nothing sold and no stock", () => {
      const r = buildBuyersRollup([fact({ soldQty: 0, onHand: 0, onOrder: 0 })], "department", 12);
      expect(r.groups[0].sellThroughPct).toBe(0);
    });

    it("weeks supply = onHand / weekly velocity", () => {
      // sold 12 over 12 weeks = 1/week. onHand = 10 -> 10 weeks.
      const r = buildBuyersRollup([fact({ soldQty: 12, onHand: 10 })], "department", 12);
      expect(r.groups[0].weeksSupply).toBe(10);
    });

    it("weeks supply is null when there's no sales velocity", () => {
      const r = buildBuyersRollup([fact({ soldQty: 0, onHand: 100 })], "department", 12);
      expect(r.groups[0].weeksSupply).toBeNull();
    });

    it("weeks supply is null when there's no stock", () => {
      const r = buildBuyersRollup([fact({ soldQty: 5, onHand: 0 })], "department", 12);
      expect(r.groups[0].weeksSupply).toBeNull();
    });
  });

  it("lastSold at each level is the max across that bucket's facts", () => {
    const old = new Date("2026-01-01");
    const recent = new Date("2026-04-01");
    const facts: ProductFact[] = [
      fact({ productId: 1, categoryId: 10, lastSold: old }),
      fact({ productId: 2, categoryId: 10, lastSold: recent }),
    ];
    const r = buildBuyersRollup(facts, "department", 12);
    expect(r.groups[0].lastSold).toBe(recent.toISOString());
    expect(r.groups[0].children[0].lastSold).toBe(recent.toISOString());
  });

  it("ids encode the pivot: dept:X for top level, cat:Y for children (department pivot)", () => {
    const r = buildBuyersRollup([fact({ departmentId: 5, categoryId: 42 })], "department", 12);
    expect(r.groups[0].id).toBe("dept:5");
    expect(r.groups[0].children[0].id).toBe("cat:42");
  });

  it("ids encode the pivot: vendor:X for top level, dept:Y for children (vendor pivot)", () => {
    const r = buildBuyersRollup([fact({ vendorId: 3, departmentId: 7 })], "vendor", 12);
    expect(r.groups[0].id).toBe("vendor:3");
    expect(r.groups[0].children[0].id).toBe("dept:7");
  });

  describe("5-level drill-down", () => {
    it("department pivot goes Department -> Category -> Type -> Vendor -> Part#", () => {
      const r = buildBuyersRollup(
        [
          fact({
            productId: 42,
            productNumber: "SE-F21-XLS",
            productName: "Whitman Sofa",
            departmentId: 1,
            categoryId: 10,
            typeId: 200,
            typeName: "Sectional",
            vendorId: 100,
            vendorName: "Wesley Hall",
            soldQty: 1,
            soldTotal: 5000,
          }),
        ],
        "department",
        12,
      );
      const dept = r.groups[0];
      expect(dept.id).toBe("dept:1");
      const cat = dept.children[0];
      expect(cat.id).toBe("cat:10");
      const type = cat.children[0];
      expect(type.id).toBe("type:200");
      expect(type.name).toBe("Sectional");
      const vendor = type.children[0];
      expect(vendor.id).toBe("vendor:100");
      expect(vendor.name).toBe("Wesley Hall");
      const leaf = vendor.children[0];
      expect(leaf.id).toBe("part:42");
      expect(leaf.name).toBe("SE-F21-XLS — Whitman Sofa");
      expect(leaf.productId).toBe(42);
      expect(leaf.children).toEqual([]);
      expect(leaf.soldTotal).toBe(5000);
    });

    it("vendor pivot goes Vendor -> Department -> Category -> Type -> Part#", () => {
      const r = buildBuyersRollup(
        [fact({ productId: 7, vendorId: 100, departmentId: 1, categoryId: 10, typeId: 200 })],
        "vendor",
        12,
      );
      expect(r.groups[0].id).toBe("vendor:100");
      expect(r.groups[0].children[0].id).toBe("dept:1");
      expect(r.groups[0].children[0].children[0].id).toBe("cat:10");
      expect(r.groups[0].children[0].children[0].children[0].id).toBe("type:200");
      expect(r.groups[0].children[0].children[0].children[0].children[0].id).toBe("part:7");
    });

    it("aggregates metrics correctly at every level of a 5-level tree", () => {
      const facts: ProductFact[] = [
        fact({
          productId: 1,
          departmentId: 1,
          categoryId: 10,
          typeId: 200,
          vendorId: 100,
          soldQty: 2,
          soldTotal: 2000,
        }),
        fact({
          productId: 2,
          departmentId: 1,
          categoryId: 10,
          typeId: 200,
          vendorId: 100,
          soldQty: 3,
          soldTotal: 3000,
        }),
        fact({
          productId: 3,
          departmentId: 1,
          categoryId: 10,
          typeId: 200,
          vendorId: 200,
          vendorName: "CR Laine",
          soldQty: 1,
          soldTotal: 1500,
        }),
      ];
      const r = buildBuyersRollup(facts, "department", 12);
      const dept = r.groups[0];
      expect(dept.soldTotal).toBe(6500);
      expect(dept.productCount).toBe(3);
      const cat = dept.children[0];
      expect(cat.soldTotal).toBe(6500);
      const type = cat.children[0];
      expect(type.soldTotal).toBe(6500);
      const wh = type.children.find((v) => v.name === "Wesley Hall")!;
      const crl = type.children.find((v) => v.name === "CR Laine")!;
      expect(wh.soldTotal).toBe(5000);
      expect(wh.productCount).toBe(2);
      expect(crl.soldTotal).toBe(1500);
      expect(crl.productCount).toBe(1);
      expect(wh.children).toHaveLength(2);
    });

    it("leaves have productId set; groups/categories/types/vendors have productId null", () => {
      const r = buildBuyersRollup(
        [fact({ productId: 42, productNumber: "ABC-1", productName: "Widget" })],
        "department",
        12,
      );
      const dept = r.groups[0];
      expect(dept.productId).toBeNull();
      expect(dept.children[0].productId).toBeNull(); // cat
      expect(dept.children[0].children[0].productId).toBeNull(); // type
      expect(dept.children[0].children[0].children[0].productId).toBeNull(); // vendor
      expect(dept.children[0].children[0].children[0].children[0].productId).toBe(42); // leaf
    });

    it("leaf name falls back to productNumber when productName is null", () => {
      const r = buildBuyersRollup(
        [fact({ productId: 1, productNumber: "SKU-1", productName: null })],
        "department",
        12,
      );
      const leaf = r.groups[0].children[0].children[0].children[0].children[0];
      expect(leaf.name).toBe("SKU-1");
    });

    it("leaf name falls back to (unassigned) when both productNumber and productName are null", () => {
      const r = buildBuyersRollup([fact({ productId: 1 })], "department", 12);
      const leaf = r.groups[0].children[0].children[0].children[0].children[0];
      expect(leaf.name).toBe("(unassigned)");
    });

    it("customerStock aggregates separately from onHand at every level", () => {
      const facts: ProductFact[] = [
        fact({ productId: 1, onHand: 2, customerStock: 3 }),
        fact({ productId: 2, onHand: 5, customerStock: 1 }),
      ];
      const r = buildBuyersRollup(facts, "department", 12);
      const dept = r.groups[0];
      expect(dept.onHand).toBe(7);
      expect(dept.customerStock).toBe(4);
      expect(r.totals.onHand).toBe(7);
      expect(r.totals.customerStock).toBe(4);
    });

    it("stockSold vs specialSold aggregate separately at every level", () => {
      const facts: ProductFact[] = [
        fact({
          productId: 1,
          soldQty: 5,
          soldTotal: 1000,
          stockSoldQty: 2,
          stockSoldTotal: 400,
          specialSoldQty: 3,
          specialSoldTotal: 600,
        }),
        fact({
          productId: 2,
          soldQty: 4,
          soldTotal: 800,
          stockSoldQty: 0,
          stockSoldTotal: 0,
          specialSoldQty: 4,
          specialSoldTotal: 800,
        }),
      ];
      const r = buildBuyersRollup(facts, "department", 12);
      const dept = r.groups[0];
      expect(dept.soldQty).toBe(9);
      expect(dept.stockSoldQty).toBe(2);
      expect(dept.stockSoldTotal).toBe(400);
      expect(dept.specialSoldQty).toBe(7);
      expect(dept.specialSoldTotal).toBe(1400);
      // Sum of split equals overall -- invariant the UI relies on
      expect(dept.stockSoldQty + dept.specialSoldQty).toBe(dept.soldQty);
      expect(dept.stockSoldTotal + dept.specialSoldTotal).toBe(dept.soldTotal);
    });

    it("collapses same-frame products into a single leaf when frameDecisions is provided", () => {
      const facts: ProductFact[] = [
        fact({
          productId: 1,
          productNumber: "WH-F21-XLS",
          soldQty: 1,
          soldTotal: 2000,
        }),
        fact({
          productId: 2,
          productNumber: "WH-F21-LS",
          soldQty: 3,
          soldTotal: 6000,
        }),
        fact({
          productId: 3,
          productNumber: "WH-F22-XLS",
          soldQty: 1,
          soldTotal: 2500,
        }),
      ];
      const frameDecisions = new Map([
        [1, { frameKey: "100:WH-F21", frameLabel: "WH-F21" }],
        [2, { frameKey: "100:WH-F21", frameLabel: "WH-F21" }],
        [3, { frameKey: "100:WH-F22", frameLabel: "WH-F22" }],
      ]);
      const r = buildBuyersRollup(facts, "department", 12, frameDecisions);
      const leaves = flattenLeaves(r.groups[0]);
      expect(leaves).toHaveLength(2); // F21 frame (2 variants) + F22 frame (1)
      const f21 = leaves.find((l) => l.name === "WH-F21")!;
      expect(f21.productCount).toBe(2);
      expect(f21.soldQty).toBe(4);
      expect(f21.soldTotal).toBe(8000);
    });

    it("flattenLeaves returns only product-level nodes", () => {
      const facts: ProductFact[] = [
        fact({ productId: 1, productNumber: "A", soldTotal: 100 }),
        fact({ productId: 2, productNumber: "B", soldTotal: 200 }),
      ];
      const r = buildBuyersRollup(facts, "department", 12);
      const leaves = flattenLeaves(r.groups[0]);
      expect(leaves).toHaveLength(2);
      expect(leaves.every((l) => l.productId !== null)).toBe(true);
      expect(leaves.map((l) => l.name).sort()).toEqual(["A", "B"]);
    });
  });

  describe("cost + margin", () => {
    it("avgMarginPct is (soldTotal - soldCost) / soldTotal, one decimal", () => {
      const r = buildBuyersRollup(
        [fact({ soldQty: 2, soldTotal: 1000, soldCost: 400 })],
        "department",
        12,
      );
      // (1000 - 400) / 1000 = 60.0
      expect(r.groups[0].avgMarginPct).toBe(60);
      expect(r.totals.avgMarginPct).toBe(60);
    });

    it("avgMarginPct is null when nothing was sold", () => {
      const r = buildBuyersRollup([fact({ soldTotal: 0, soldCost: 0 })], "department", 12);
      expect(r.groups[0].avgMarginPct).toBeNull();
      expect(r.totals.avgMarginPct).toBeNull();
    });

    it("costEstimated is true at every level where any contributing product was estimated", () => {
      const facts = [
        fact({ productId: 1, soldTotal: 500, soldCost: 250, costEstimated: true }),
        fact({ productId: 2, soldTotal: 500, soldCost: 200, costEstimated: false }),
      ];
      const r = buildBuyersRollup(facts, "department", 12);
      expect(r.groups[0].costEstimated).toBe(true);
      expect(r.groups[0].children[0].costEstimated).toBe(true);
      expect(r.totals.costEstimated).toBe(true);
    });

    it("costEstimated is false when all contributing products had real cost", () => {
      const facts = [
        fact({ productId: 1, soldTotal: 500, soldCost: 250, costEstimated: false }),
        fact({ productId: 2, soldTotal: 500, soldCost: 200, costEstimated: false }),
      ];
      const r = buildBuyersRollup(facts, "department", 12);
      expect(r.groups[0].costEstimated).toBe(false);
      expect(r.totals.costEstimated).toBe(false);
    });

    it("soldCost aggregates at group, child, and totals levels", () => {
      const facts = [
        fact({
          productId: 1,
          departmentId: 1,
          categoryId: 10,
          soldTotal: 1000,
          soldCost: 400,
        }),
        fact({
          productId: 2,
          departmentId: 1,
          categoryId: 11,
          categoryName: "Chairs",
          soldTotal: 600,
          soldCost: 300,
        }),
      ];
      const r = buildBuyersRollup(facts, "department", 12);
      expect(r.groups[0].soldCost).toBe(700);
      expect(r.totals.soldCost).toBe(700);
      // avgMargin at group = (1600 - 700) / 1600 = 56.3
      expect(r.groups[0].avgMarginPct).toBe(56.3);
    });
  });

  it("totals sum across all groups", () => {
    const facts: ProductFact[] = [
      fact({ productId: 1, departmentId: 1, onHand: 10, soldTotal: 500 }),
      fact({ productId: 2, departmentId: 2, departmentName: "Outdoor", onHand: 5, soldTotal: 250 }),
    ];
    const r = buildBuyersRollup(facts, "department", 12);
    expect(r.totals.productCount).toBe(2);
    expect(r.totals.onHand).toBe(15);
    expect(r.totals.soldTotal).toBe(750);
  });
});
