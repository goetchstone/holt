// /app/__tests__/buyerDraftExport.test.ts
//
// A-grade unit tests for `lib/buyerDraftExport.ts`. Pure helpers — no DB.
// Asserts the actual CSV bytes and header order so a future "let's just
// reorder the columns" change can't silently break the POS's importer.

import {
  buildItemsCsv,
  buildPosCsv,
  ITEMS_CSV_HEADERS,
  ITEMS_CSV_BARCODE_HEADER,
  POS_CSV_HEADERS,
  type DraftItemForExport,
  type DraftPoForExport,
} from "@/lib/buyerDraftExport";

// Base fixture uses a comma-free description so the tests below can split
// rows by comma when checking specific cell positions. Tests that exercise
// the CSV escaper (commas, quotes, newlines) override `description`.
const baseItem: DraftItemForExport = {
  partNumber: "L2272-05SW",
  productName: "Murphey Swivel Chair",
  description: "Leather Stetson Chestnut Grade 13 Cushion Mayfair",
  cost: 1275,
  retail: 3039,
  msrp: 4050,
  productWidth: 30,
  productLength: 39.5,
  productHeight: 34,
  departmentName: "Furniture",
  categoryName: "Chairs",
  stockFamily: null,
  supplierName: "CR Laine",
  qty: 6,
  draftPoId: 1,
  stockLocationCode: "OS-WHSE",
  barcode: null,
};

// ─── Items CSV ─────────────────────────────────────────────────────────

describe("buildItemsCsv", () => {
  it("emits the exact header order the POS expects (no Barcode by default)", () => {
    const csv = buildItemsCsv([]);
    expect(csv.trim()).toBe(
      "Category,Cost Price,Department,Description,Part Number,Product Name,Product Height,Product Length,Product Width,Selling Price,RRP,Stock Family,Supplier",
    );
  });

  it("matches the published header constant (regression guard)", () => {
    // If someone reorders ITEMS_CSV_HEADERS the CSV builder MUST match;
    // this test asserts the constant doesn't drift from the doc-string spec.
    expect(ITEMS_CSV_HEADERS).toEqual([
      "Category",
      "Cost Price",
      "Department",
      "Description",
      "Part Number",
      "Product Name",
      "Product Height",
      "Product Length",
      "Product Width",
      "Selling Price",
      "RRP",
      "Stock Family",
      "Supplier",
    ]);
  });

  it("renders a single furniture row with all fields populated", () => {
    const csv = buildItemsCsv([baseItem]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[1]).toBe(
      [
        "Chairs",
        "1275.00",
        "Furniture",
        "Leather Stetson Chestnut Grade 13 Cushion Mayfair", // no commas → no escaping
        "L2272-05SW",
        "Murphey Swivel Chair",
        "34", // height — trailing zeros trimmed
        "39.5", // length — trailing zero trimmed
        "30", // width — trailing zeros trimmed
        "3039.00",
        "4050.00",
        "", // stockFamily empty
        "CR Laine",
      ].join(","),
    );
  });

  it("escapes commas, quotes, and newlines inside descriptions", () => {
    const item: DraftItemForExport = {
      ...baseItem,
      description: 'Fabric: "Cream", Grade 1\nStandard mattress',
    };
    const csv = buildItemsCsv([item]);
    // Embedded quotes doubled; whole field wrapped in quotes
    expect(csv).toContain('"Fabric: ""Cream"", Grade 1\nStandard mattress"');
  });

  it("renders empty cells for null money fields (msrp absent)", () => {
    const item: DraftItemForExport = { ...baseItem, msrp: null };
    const csv = buildItemsCsv([item]);
    const lines = csv.trim().split("\n");
    // RRP column (index 10) should be empty
    expect(lines[1].split(",")[10]).toBe("");
  });

  it("renders empty cells for null dimensions", () => {
    const item: DraftItemForExport = {
      ...baseItem,
      productWidth: null,
      productLength: null,
      productHeight: null,
    };
    const csv = buildItemsCsv([item]);
    const cells = csv.trim().split("\n")[1].split(",");
    expect(cells[6]).toBe(""); // height
    expect(cells[7]).toBe(""); // length
    expect(cells[8]).toBe(""); // width
  });

  it("auto-includes the Barcode column when any item has a barcode", () => {
    const apparel: DraftItemForExport = {
      ...baseItem,
      barcode: "012345678905",
      partNumber: "MOG-T-NAVY-M",
      productName: "Navy T-Shirt M",
    };
    const csv = buildItemsCsv([baseItem, apparel]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain(ITEMS_CSV_BARCODE_HEADER);
    expect(lines[0].split(",")).toHaveLength(14); // 13 base + Barcode
    // Furniture row leaves barcode empty; apparel row has it
    expect(lines[1].endsWith(",")).toBe(true);
    expect(lines[2].split(",").pop()).toBe("012345678905");
  });

  it("respects an explicit includeBarcodeColumn=false override", () => {
    const apparel: DraftItemForExport = { ...baseItem, barcode: "012345678905" };
    const csv = buildItemsCsv([apparel], { includeBarcodeColumn: false });
    expect(csv.split("\n")[0]).not.toContain(ITEMS_CSV_BARCODE_HEADER);
  });

  it("respects an explicit includeBarcodeColumn=true override (empty barcodes throughout)", () => {
    const csv = buildItemsCsv([baseItem], { includeBarcodeColumn: true });
    const headers = csv.split("\n")[0].split(",");
    expect(headers).toContain(ITEMS_CSV_BARCODE_HEADER);
    // All-empty barcode cell still emitted to align column count
    expect(csv.split("\n")[1].split(",")).toHaveLength(14);
  });

  it("trims trailing zeros from dimensions", () => {
    const item: DraftItemForExport = {
      ...baseItem,
      productWidth: 30.0,
      productLength: 33.25,
      productHeight: 36.5,
    };
    const csv = buildItemsCsv([item]);
    const cells = csv.trim().split("\n")[1].split(",");
    expect(cells[6]).toBe("36.5"); // height
    expect(cells[7]).toBe("33.25"); // length
    expect(cells[8]).toBe("30"); // width
  });

  it("formats money to exactly 2 decimals (no thousands separator, no symbol)", () => {
    const item: DraftItemForExport = {
      ...baseItem,
      cost: 1275.0,
      retail: 3039.5,
      msrp: 4050.999,
    };
    const csv = buildItemsCsv([item]);
    const cells = csv.trim().split("\n")[1].split(",");
    expect(cells[1]).toBe("1275.00");
    expect(cells[9]).toBe("3039.50");
    expect(cells[10]).toBe("4051.00"); // 4050.999 rounds to 4051.00 via toFixed
  });

  it("returns header-only when given an empty list", () => {
    const csv = buildItemsCsv([]);
    expect(csv.trim().split("\n")).toHaveLength(1);
  });
});

// ─── POs CSV ───────────────────────────────────────────────────────────

describe("buildPosCsv", () => {
  const po: DraftPoForExport = {
    id: 1,
    referenceNumber: "PON08000",
    supplierName: "CR Laine",
  };

  it("emits the exact header order the POS expects", () => {
    const csv = buildPosCsv([], new Map());
    expect(csv.trim()).toBe(
      "Supplier,Qty,Part Number,Location Code,Cost Price,Description,Reference Number",
    );
  });

  it("matches the published header constant (regression guard)", () => {
    expect(POS_CSV_HEADERS).toEqual([
      "Supplier",
      "Qty",
      "Part Number",
      "Location Code",
      "Cost Price",
      "Description",
      "Reference Number",
    ]);
  });

  it("emits one row per item with the PO's reference number repeated", () => {
    const items: DraftItemForExport[] = [
      { ...baseItem, partNumber: "L2272-05SW", qty: 6 },
      { ...baseItem, partNumber: "1230-20", productName: "Magnolia Sofa", qty: 1, cost: 1873.8 },
    ];
    const csv = buildPosCsv([po], new Map([[1, items]]));
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 data
    expect(lines[1]).toBe(
      [
        "CR Laine",
        "6",
        "L2272-05SW",
        "OS-WHSE",
        "1275.00",
        "Leather Stetson Chestnut Grade 13 Cushion Mayfair",
        "PON08000",
      ].join(","),
    );
    expect(lines[2]).toBe(
      [
        "CR Laine",
        "1",
        "1230-20",
        "OS-WHSE",
        "1873.80",
        "Leather Stetson Chestnut Grade 13 Cushion Mayfair",
        "PON08000",
      ].join(","),
    );
  });

  it("emits empty Reference Number cell when referenceNumber is null", () => {
    const noRefPo: DraftPoForExport = { ...po, referenceNumber: null };
    const csv = buildPosCsv([noRefPo], new Map([[1, [baseItem]]]));
    const cells = csv.trim().split("\n")[1].split(",");
    expect(cells[6]).toBe("");
  });

  it("emits empty Location Code cell when stockLocationCode is null", () => {
    const item: DraftItemForExport = { ...baseItem, stockLocationCode: null };
    const csv = buildPosCsv([po], new Map([[1, [item]]]));
    const cells = csv.trim().split("\n")[1].split(",");
    expect(cells[3]).toBe("");
  });

  it("omits POs that have no items in the map", () => {
    const csv = buildPosCsv([po], new Map()); // empty map
    expect(csv.trim().split("\n")).toHaveLength(1); // header only
  });

  it("groups multiple POs in stable order", () => {
    const po2: DraftPoForExport = {
      id: 2,
      referenceNumber: "PON08001",
      supplierName: "Wesley Hall",
    };
    const items1: DraftItemForExport[] = [{ ...baseItem, partNumber: "A1", qty: 2 }];
    const items2: DraftItemForExport[] = [
      { ...baseItem, partNumber: "B1", qty: 3, supplierName: "Wesley Hall" },
    ];
    const csv = buildPosCsv(
      [po, po2],
      new Map([
        [1, items1],
        [2, items2],
      ]),
    );
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("PON08000");
    expect(lines[2]).toContain("PON08001");
    expect(lines[2].split(",")[0]).toBe("Wesley Hall");
  });
});
