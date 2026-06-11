// /app/__tests__/integration/runProductsImport.integration.test.ts
//
// Real-DB integration tests for runProductsImport — the shared runner
// behind both the manual product upload AND the daily SH_Item_Export
// auto-import added 2026-05-26.
//
// What we're protecting:
//
//   1. Column aliases — SH Item Export uses spaced headers ("Part No",
//      "Product Name", "Item Length", "Barcode No", "Product Family")
//      while the legacy manual upload uses unspaced snake_case keys
//      ("part_no", "Product_name", "length", "Barcode", "Family").
//      Both shapes must produce identical Product rows.
//
//   2. Active flag handling — `Active = yes` must flip isActive=true
//      and isDiscontinued=false; absent / blank Active must NOT touch
//      existing flag state (so the manual UI's skipInactive option
//      still does what it claims).
//
//   3. Barcode handling — the POS emits "0" as a "no barcode"
//      placeholder. That must NOT create a Upc row with upc="0"
//      (would collide on the unique constraint at scale).
//
//   4. Auto-create of missing taxonomy — rows whose Supplier /
//      Department / Category aren't in the DB yet must land via
//      Unknown Vendor / Uncategorized fallbacks (so 100K-row imports
//      don't fail on the first new vendor).
//
//   5. Active=no flips isActive=false on existing products.
//
//   6. Self-chunking — runProductsImport processes 500 rows per
//      DB transaction internally. Asserting on a small fixture
//      pins the contract; the chunking math is exercised any time
//      a real >500-row import runs.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { runProductsImport } from "@/lib/adapters/ordorite/runners";

interface ShItemRow extends Record<string, unknown> {
  Active: string;
  "Barcode No": string;
  Department: string;
  Category: string;
  Categorytype: string;
  Id: string;
  Supplier: string;
  "Part No": string;
  "Product Description": string;
  "Product Name": string;
  "Selling Price": string;
  "Purchasing Cost": string;
  "Item Height": string;
  "Item Length": string;
  "Item Width": string;
  "Product Family": string;
}

function shItemRow(overrides: Partial<ShItemRow> & { Id: string; "Part No": string }): ShItemRow {
  const partNo = overrides["Part No"];
  return {
    Active: "yes",
    "Barcode No": "",
    Department: "Furniture",
    Category: "Sofas",
    Categorytype: "",
    Supplier: "Wesley Hall",
    "Product Description": `Description for ${partNo}`,
    "Product Name": `Product ${partNo}`,
    "Selling Price": "1000.00",
    "Purchasing Cost": "500.00",
    "Item Height": "30",
    "Item Length": "80",
    "Item Width": "36",
    "Product Family": "SPR26",
    ...overrides,
  };
}

describe("runProductsImport — real-DB scenarios", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ─── SH Item Export column aliases ───────────────────────────────────

  it("creates products from SH Item Export rows with spaced headers", async () => {
    const result = await runProductsImport([
      shItemRow({ Id: "100001", "Part No": "WH-SOFA-001" }),
      shItemRow({ Id: "100002", "Part No": "WH-SOFA-002" }),
    ]);

    expect(result.productsCreated).toBe(2);
    expect(result.productsUpdated).toBe(0);
    expect(result.errors).toEqual([]);

    const products = await prisma.product.findMany({
      where: { externalId: { in: [100001, 100002] } },
      include: { vendor: true, department: true, category: true },
      orderBy: { externalId: "asc" },
    });

    expect(products).toHaveLength(2);
    expect(products[0].productNumber).toBe("WH-SOFA-001");
    expect(products[0].name).toBe("Product WH-SOFA-001");
    expect(products[0].description).toBe("Description for WH-SOFA-001");
    expect(products[0].vendor.name).toBe("Wesley Hall");
    expect(products[0].department.name).toBe("Furniture");
    expect(products[0].category.name).toBe("Sofas");
    expect(Number(products[0].baseCost)).toBe(500);
    expect(Number(products[0].baseRetail)).toBe(1000);
    expect(products[0].season).toBe("SPR26");
    expect(products[0].length).toBe(80);
    expect(products[0].width).toBe(36);
    expect(products[0].height).toBe(30);
    expect(products[0].isActive).toBe(true);
    expect(products[0].isDiscontinued).toBe(false);
  });

  it("accepts both spaced and snake_case headers in a mixed batch", async () => {
    // Manual-upload-style row (legacy snake_case).
    const legacyRow: Record<string, unknown> = {
      id: "100050",
      part_no: "LEGACY-001",
      Product_name: "Legacy Sofa",
      description: "Legacy description",
      Supplier: "Wesley Hall",
      department: "Furniture",
      category: "Sofas",
      Type: "Standard Sofa",
      Family: "FALL25",
      cost_price: "400",
      selling_price: "900",
      length: "75",
      width: "32",
      height: "28",
      Barcode: "123456789012",
    };

    // SH Item Export row (spaced headers).
    const newRow = shItemRow({
      Id: "100051",
      "Part No": "NEW-001",
      Categorytype: "Standard Sofa",
      "Barcode No": "987654321098",
    });

    const result = await runProductsImport([legacyRow, newRow]);
    expect(result.productsCreated).toBe(2);
    expect(result.errors).toEqual([]);

    const legacy = await prisma.product.findUnique({
      where: { externalId: 100050 },
      include: { type: true, upcs: true },
    });
    expect(legacy).not.toBeNull();
    expect(legacy!.productNumber).toBe("LEGACY-001");
    expect(legacy!.name).toBe("Legacy Sofa");
    expect(legacy!.season).toBe("FALL25");
    expect(Number(legacy!.baseCost)).toBe(400);
    expect(legacy!.type?.name).toBe("Standard Sofa");
    expect(legacy!.upcs.map((u) => u.upc)).toEqual(["123456789012"]);

    const fresh = await prisma.product.findUnique({
      where: { externalId: 100051 },
      include: { type: true, upcs: true },
    });
    expect(fresh).not.toBeNull();
    expect(fresh!.season).toBe("SPR26"); // Product Family mapping
    expect(fresh!.type?.name).toBe("Standard Sofa"); // Categorytype mapping
    expect(fresh!.upcs.map((u) => u.upc)).toEqual(["987654321098"]);
  });

  // ─── Active flag handling ────────────────────────────────────────────

  it("Active=yes on an EXISTING inactive product reactivates it", async () => {
    // Seed an existing inactive product (operator-flagged out).
    const vendor = await prisma.vendor.create({
      data: { name: "Wesley Hall", pricingModel: "FLAT" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
    });
    await prisma.product.create({
      data: {
        externalId: 200001,
        productNumber: "WH-200001",
        name: "Old Name",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        isActive: false,
        isDiscontinued: true,
      },
    });

    const result = await runProductsImport([
      shItemRow({ Id: "200001", "Part No": "WH-200001", Active: "yes" }),
    ]);

    expect(result.productsUpdated).toBe(1);
    const after = await prisma.product.findUnique({ where: { externalId: 200001 } });
    expect(after!.isActive).toBe(true);
    expect(after!.isDiscontinued).toBe(false);
  });

  it("Active=no on an EXISTING active product flips isActive to false", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Wesley Hall", pricingModel: "FLAT" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
    });
    await prisma.product.create({
      data: {
        externalId: 200002,
        productNumber: "WH-200002",
        name: "Active Product",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        isActive: true,
      },
    });

    const result = await runProductsImport([
      shItemRow({ Id: "200002", "Part No": "WH-200002", Active: "no" }),
    ]);

    expect(result.productsUpdated).toBe(1);
    const after = await prisma.product.findUnique({ where: { externalId: 200002 } });
    expect(after!.isActive).toBe(false);
  });

  it("absent Active column on an EXISTING inactive product does NOT reactivate (legacy manual upload)", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Wesley Hall", pricingModel: "FLAT" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
    });
    await prisma.product.create({
      data: {
        externalId: 200003,
        productNumber: "WH-200003",
        name: "Operator-Inactivated",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        isActive: false,
        isDiscontinued: true,
      },
    });

    // Legacy CSV row with no Active column at all.
    const legacyRow: Record<string, unknown> = {
      id: "200003",
      part_no: "WH-200003",
      Product_name: "Operator-Inactivated",
      Supplier: "Wesley Hall",
      department: "Furniture",
      category: "Sofas",
    };

    const result = await runProductsImport([legacyRow]);
    expect(result.productsUpdated).toBe(1);

    const after = await prisma.product.findUnique({ where: { externalId: 200003 } });
    // Critical: flags untouched. Operator override survives the import.
    expect(after!.isActive).toBe(false);
    expect(after!.isDiscontinued).toBe(true);
  });

  it("skipInactive option preserves existing inactive products entirely (no update)", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Wesley Hall", pricingModel: "FLAT" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
    });
    await prisma.product.create({
      data: {
        externalId: 200004,
        productNumber: "WH-200004",
        name: "Original Name — Keep Me",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        isActive: false,
        isDiscontinued: true,
      },
    });

    const result = await runProductsImport(
      [
        shItemRow({
          Id: "200004",
          "Part No": "WH-200004",
          "Product Name": "Reactivated Name Should Not Apply",
          Active: "yes",
        }),
      ],
      undefined,
      { skipInactive: true },
    );

    expect(result.productsUpdated).toBe(0);
    expect(result.skippedInactiveCount).toBe(1);

    const after = await prisma.product.findUnique({ where: { externalId: 200004 } });
    expect(after!.name).toBe("Original Name — Keep Me");
    expect(after!.isActive).toBe(false);
  });

  // ─── Barcode placeholder + auto-create taxonomy ──────────────────────

  it("ignores Barcode No = '0' (POS placeholder for no-barcode)", async () => {
    const result = await runProductsImport([
      shItemRow({ Id: "300001", "Part No": "NO-BC-001", "Barcode No": "0" }),
      shItemRow({ Id: "300002", "Part No": "NO-BC-002", "Barcode No": "0.0" }),
      shItemRow({ Id: "300003", "Part No": "REAL-BC", "Barcode No": "555000111222" }),
    ]);
    expect(result.productsCreated).toBe(3);
    expect(result.upcsCreated).toBe(1);

    const upcs = await prisma.upc.findMany({ orderBy: { upc: "asc" } });
    expect(upcs.map((u) => u.upc)).toEqual(["555000111222"]);
  });

  it("auto-creates Unknown Vendor / Uncategorized fallback when columns are blank", async () => {
    const result = await runProductsImport([
      shItemRow({
        Id: "400001",
        "Part No": "ORPHAN-001",
        Supplier: "",
        Department: "",
        Category: "",
      }),
    ]);
    expect(result.productsCreated).toBe(1);
    expect(result.errors).toEqual([]);

    const product = await prisma.product.findUnique({
      where: { externalId: 400001 },
      include: { vendor: true, department: true, category: true },
    });
    expect(product!.vendor.name).toBe("Unknown Vendor");
    expect(product!.department.name).toBe("Uncategorized");
    expect(product!.category.name).toBe("Uncategorized");
  });

  // ─── Self-chunking ──────────────────────────────────────────────────

  it("processes a batch larger than one internal chunk (>500 rows)", async () => {
    // Build 501 rows — just over the internal PRODUCTS_IMPORT_CHUNK_SIZE.
    // We're not asserting on chunking math directly (that's a private
    // constant); we're asserting the runner handles a batch that
    // crosses the boundary without losing rows or returning errors.
    const rows = Array.from({ length: 501 }, (_, i) =>
      shItemRow({ Id: `${500001 + i}`, "Part No": `CHUNK-${i}` }),
    );
    const result = await runProductsImport(rows);
    expect(result.productsCreated).toBe(501);
    expect(result.productsUpdated).toBe(0);
    expect(result.errors).toEqual([]);

    const count = await prisma.product.count({
      where: { externalId: { gte: 500001, lte: 500501 } },
    });
    expect(count).toBe(501);
  });

  // ─── Reports the right keys for the orchestrator's recordCount ───────

  it("returns productsCreated + productsUpdated keys for the orchestrator", async () => {
    const result = await runProductsImport([
      shItemRow({ Id: "600001", "Part No": "KEYS-001" }),
    ]);
    // Match the orchestrator's expectation
    // (lib/adapters/ordorite/orchestrator.ts).
    expect(result).toHaveProperty("productsCreated");
    expect(result).toHaveProperty("productsUpdated");
    expect(result.productsCreated + result.productsUpdated).toBeGreaterThan(0);
  });
});
