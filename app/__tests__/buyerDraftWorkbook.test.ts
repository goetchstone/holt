// /app/__tests__/buyerDraftWorkbook.test.ts
//
// A-grade unit tests for `lib/buyerDraftWorkbook.ts`. Pure helper — no DB,
// no I/O. Asserts the workbook shape (sheet names, column order, row
// content, sanitized vendor names) so a regression in the buyer-facing
// XLSX export fails red.

import * as XLSX from "xlsx";
import {
  buildBuyerWorkbook,
  sanitizeSheetName,
  expectedShipMonthToMonthName,
  VENDOR_SHEET_HEADERS,
  FLOOR_PLAN_HEADERS,
  DEFAULT_PIVOT_MONTHS,
  type WorkbookItem,
} from "@/lib/buyerDraftWorkbook";

const baseItem: WorkbookItem = {
  partNumber: "L2272-05SW",
  productName: "Murphey Swivel Chair",
  description: "Fabric: Stetson Chestnut\nGrade: 13",
  barcode: null,
  qty: 6,
  cost: 1275,
  msrp: 4050,
  retail: 3039,
  sku: null,
  poReference: "PON08000",
  supplierName: "CR Laine",
  storeLocationName: "Main Store",
  storeLocationCode: "OS",
  vignette: "Vignette 1",
  stockProgram: false,
  // Stored as canonical YYYY-MM. `expectedShipMonthToMonthName`
  // derives the pivot's column key from this.
  expectedShipMonth: "2026-03",
  buyName: null,
};

// ─── expectedShipMonthToMonthName ──────────────────────────────────────

describe("expectedShipMonthToMonthName", () => {
  it("returns the long English month name for YYYY-MM input", () => {
    expect(expectedShipMonthToMonthName("2026-01")).toBe("January");
    expect(expectedShipMonthToMonthName("2026-09")).toBe("September");
    expect(expectedShipMonthToMonthName("2025-12")).toBe("December");
  });

  it("returns the same month name for MM-YYYY input (legacy shape)", () => {
    expect(expectedShipMonthToMonthName("01-2026")).toBe("January");
    expect(expectedShipMonthToMonthName("09-2026")).toBe("September");
  });

  it("returns 'Unscheduled' for null or empty input", () => {
    expect(expectedShipMonthToMonthName(null)).toBe("Unscheduled");
    expect(expectedShipMonthToMonthName("")).toBe("Unscheduled");
  });

  it("returns 'Unscheduled' for unparseable strings (e.g. legacy free text)", () => {
    expect(expectedShipMonthToMonthName("March")).toBe("Unscheduled");
    expect(expectedShipMonthToMonthName("garbage")).toBe("Unscheduled");
  });
});

// ─── sanitizeSheetName ─────────────────────────────────────────────────

describe("sanitizeSheetName", () => {
  it("returns short names unchanged", () => {
    expect(sanitizeSheetName("CR Laine")).toBe("CR Laine");
    expect(sanitizeSheetName("AL")).toBe("AL");
  });

  it("replaces illegal characters with underscore", () => {
    expect(sanitizeSheetName("Vendor: A/B")).toBe("Vendor_ A_B");
    expect(sanitizeSheetName("Foo[Bar]?")).toBe("Foo_Bar__");
  });

  it("truncates to 31 chars", () => {
    expect(sanitizeSheetName("A".repeat(40))).toHaveLength(31);
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeSheetName("  CR Laine  ")).toBe("CR Laine");
  });

  it("falls back to 'Vendor' on empty input", () => {
    expect(sanitizeSheetName("")).toBe("Vendor");
    expect(sanitizeSheetName("   ")).toBe("Vendor");
  });
});

// ─── Workbook structure ────────────────────────────────────────────────

describe("buildBuyerWorkbook — sheet structure", () => {
  it("emits TOTAL pivot first, then per-vendor sheets, then Floor Plan", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, supplierName: "CR Laine" },
      { ...baseItem, supplierName: "Wesley Hall", partNumber: "WH-100" },
      { ...baseItem, supplierName: "AL", partNumber: "AL-1" },
    ];
    const wb = buildBuyerWorkbook(items);
    expect(wb.SheetNames).toEqual(["TOTAL", "AL", "CR Laine", "Wesley Hall", "Floor Plan"]);
  });

  it("omits Floor Plan when includeFloorPlan: false", () => {
    const wb = buildBuyerWorkbook([baseItem], { includeFloorPlan: false });
    expect(wb.SheetNames).not.toContain("Floor Plan");
  });

  it("orders vendor sheets alphabetically by default", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, supplierName: "Zimmerman" },
      { ...baseItem, supplierName: "AL" },
      { ...baseItem, supplierName: "CR Laine" },
    ];
    const wb = buildBuyerWorkbook(items, { includeFloorPlan: false });
    // TOTAL is first, then alpha
    expect(wb.SheetNames).toEqual(["TOTAL", "AL", "CR Laine", "Zimmerman"]);
  });

  it("orders vendor sheets by total cost desc when requested", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, supplierName: "Cheap", qty: 1, cost: 100 }, // total 100
      { ...baseItem, supplierName: "Expensive", qty: 5, cost: 1000 }, // total 5000
      { ...baseItem, supplierName: "Mid", qty: 2, cost: 500 }, // total 1000
    ];
    const wb = buildBuyerWorkbook(items, {
      vendorSheetOrder: "by-total-cost-desc",
      includeFloorPlan: false,
    });
    expect(wb.SheetNames).toEqual(["TOTAL", "Expensive", "Mid", "Cheap"]);
  });

  it("returns a valid empty workbook when given no items", () => {
    const wb = buildBuyerWorkbook([]);
    expect(wb.SheetNames).toEqual(["TOTAL", "Floor Plan"]);
  });

  it("sets workbook properties when provided", () => {
    const wb = buildBuyerWorkbook([baseItem], { title: "Spring 2026", author: "Buyer" });
    expect(wb.Props?.Title).toBe("Spring 2026");
    expect(wb.Props?.Author).toBe("Buyer");
  });
});

// ─── Per-vendor sheet content ──────────────────────────────────────────

describe("buildBuyerWorkbook — per-vendor sheet", () => {
  it("emits the OTB column headers in the right order (Barcode inserted at index 3)", () => {
    expect(VENDOR_SHEET_HEADERS).toEqual([
      "Item#",
      "Item Name",
      "Description",
      "Barcode",
      "Qty",
      "Cost",
      "Total Cost",
      "MSRP",
      "Retail",
      "Total Retail",
      "SKU#",
      "PON",
      "Stocking",
    ]);

    const wb = buildBuyerWorkbook([baseItem]);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: null });
    expect(rows[0]).toEqual([...VENDOR_SHEET_HEADERS]);
  });

  it("emits one row per item with computed Total Cost / Total Retail", () => {
    const wb = buildBuyerWorkbook([baseItem]);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(rows[1]).toEqual([
      "L2272-05SW",
      "Murphey Swivel Chair",
      "Fabric: Stetson Chestnut\nGrade: 13",
      "", // Barcode (null → empty string in cell)
      6,
      1275,
      7650, // 6 * 1275
      4050,
      3039,
      18234, // 6 * 3039
      "",
      "PON08000",
      "",
    ]);
  });

  it("renders barcode in column index 3 when item has one (scanned UPC)", () => {
    const scanned: WorkbookItem = { ...baseItem, barcode: "012345678905" };
    const wb = buildBuyerWorkbook([scanned]);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(rows[1]?.[3]).toBe("012345678905");
  });

  it("renders SKU in column index 10 when item is linked to a catalog Product", () => {
    const linked: WorkbookItem = { ...baseItem, sku: "WH-660" };
    const wb = buildBuyerWorkbook([linked]);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(rows[1]?.[10]).toBe("WH-660");
  });

  it("renders a Stocking tag when stockProgram is true", () => {
    const stocking: WorkbookItem = { ...baseItem, stockProgram: true };
    const wb = buildBuyerWorkbook([stocking]);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(rows[1]?.[12]).toBe("Stocking"); // index shifted by Barcode insertion
  });

  it("emits a TOTAL row at the bottom of the per-vendor sheet", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, partNumber: "P1", qty: 6, cost: 1275, retail: 3039 },
      { ...baseItem, partNumber: "P2", qty: 1, cost: 1873, retail: 4685 },
    ];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    // Header (1) + 2 items + blank spacer + total row
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const totalRow = rows[rows.length - 1] as unknown[];
    expect(totalRow[4]).toBe("TOTAL"); // shifted by Barcode insertion
    expect(totalRow[6]).toBeCloseTo(6 * 1275 + 1 * 1873, 2); // Total Cost column
    expect(totalRow[9]).toBeCloseTo(6 * 3039 + 1 * 4685, 2); // Total Retail column
  });

  it("renders empty MSRP cell when null (not '0' or '—')", () => {
    const item: WorkbookItem = { ...baseItem, msrp: null };
    const wb = buildBuyerWorkbook([item]);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
    // MSRP is now at index 7 (shifted by Barcode insertion).
    expect(rows[1]?.[7]).toBeNull();
  });

  it("preserves multi-line descriptions verbatim (newlines kept in cell)", () => {
    const item: WorkbookItem = {
      ...baseItem,
      description: "Fabric: Sky\nGrade: 13\nCleaning Code: S",
    };
    const wb = buildBuyerWorkbook([item]);
    const ws = wb.Sheets["CR Laine"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(rows[1]?.[2]).toBe("Fabric: Sky\nGrade: 13\nCleaning Code: S");
  });
});

// ─── TOTAL pivot ───────────────────────────────────────────────────────

describe("buildBuyerWorkbook — TOTAL pivot", () => {
  it("sums total cost per vendor per ship month (YYYY-MM → month name)", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, supplierName: "AL", expectedShipMonth: "2026-03", qty: 1, cost: 100 },
      { ...baseItem, supplierName: "AL", expectedShipMonth: "2026-03", qty: 2, cost: 50 },
      { ...baseItem, supplierName: "AL", expectedShipMonth: "2026-04", qty: 1, cost: 300 },
      { ...baseItem, supplierName: "BY", expectedShipMonth: "2026-03", qty: 4, cost: 999 },
    ];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets.TOTAL;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });

    const header = rows[0] as string[];
    const marchIdx = header.indexOf("March");
    const aprilIdx = header.indexOf("April");

    const al = rows.find((r) => (r as unknown[])[0] === "AL") as unknown[];
    const by = rows.find((r) => (r as unknown[])[0] === "BY") as unknown[];

    expect(al[marchIdx]).toBe(200); // 1*100 + 2*50
    expect(al[aprilIdx]).toBe(300); // 1*300
    expect(al[al.length - 1]).toBe(500); // total = 200 + 300
    expect(by[marchIdx]).toBe(3996); // 4*999
  });

  it("accepts MM-YYYY format and maps to the same month-name pivot key", () => {
    // Legacy iPad-Safari-quirk data uses MM-YYYY. Both shapes should
    // land under the same "March" column.
    const items: WorkbookItem[] = [
      { ...baseItem, supplierName: "AL", expectedShipMonth: "2026-03", qty: 1, cost: 100 },
      { ...baseItem, supplierName: "AL", expectedShipMonth: "03-2026", qty: 1, cost: 200 },
    ];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets.TOTAL;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const header = rows[0] as string[];
    const marchIdx = header.indexOf("March");
    const al = rows.find((r) => (r as unknown[])[0] === "AL") as unknown[];
    expect(al[marchIdx]).toBe(300); // both lines combined
  });

  it("emits a grand-total row at the bottom", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, supplierName: "AL", qty: 1, cost: 100, expectedShipMonth: "2026-03" },
      { ...baseItem, supplierName: "BY", qty: 1, cost: 200, expectedShipMonth: "2026-03" },
    ];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets.TOTAL;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const totalRow = rows[rows.length - 1] as unknown[];
    expect(totalRow[0]).toBe("TOTAL");
    expect(totalRow[totalRow.length - 1]).toBe(300);
  });

  it("buckets items with no expectedShipMonth under 'Unscheduled'", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, supplierName: "AL", qty: 1, cost: 100, expectedShipMonth: null },
      { ...baseItem, supplierName: "AL", qty: 1, cost: 50, expectedShipMonth: null },
    ];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets.TOTAL;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const header = rows[0] as string[];
    expect(header).toContain("Unscheduled");
    const unschedIdx = header.indexOf("Unscheduled");
    const al = rows.find((r) => (r as unknown[])[0] === "AL") as unknown[];
    expect(al[unschedIdx]).toBe(150);
  });

  it("includes all 12 default month columns even if no items use them", () => {
    const wb = buildBuyerWorkbook([baseItem]);
    const ws = wb.Sheets.TOTAL;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const header = rows[0] as string[];
    for (const m of DEFAULT_PIVOT_MONTHS) {
      expect(header).toContain(m);
    }
  });
});

// ─── Floor Plan ────────────────────────────────────────────────────────

describe("buildBuyerWorkbook — Floor Plan sheet", () => {
  it("emits the floor-plan column headers", () => {
    const wb = buildBuyerWorkbook([baseItem]);
    const ws = wb.Sheets["Floor Plan"];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    expect(rows[0]).toEqual([...FLOOR_PLAN_HEADERS]);
  });

  it("groups items by Location → Vignette", () => {
    const items: WorkbookItem[] = [
      {
        ...baseItem,
        storeLocationName: "Main Store",
        vignette: "Vignette 1",
        productName: "Sofa A",
      },
      {
        ...baseItem,
        storeLocationName: "Main Store",
        vignette: "Vignette 1",
        productName: "Chair A",
      },
      {
        ...baseItem,
        storeLocationName: "Main Store",
        vignette: "Vignette 2",
        productName: "Lamp B",
      },
      {
        ...baseItem,
        storeLocationName: "Downtown",
        vignette: "Window",
        productName: "Bench C",
      },
    ];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets["Floor Plan"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    // Downtown sorts before Main Store (alpha)
    const dataRows = rows.slice(1);
    expect(dataRows[0]?.[0]).toBe("Downtown");
    expect(dataRows[0]?.[2]).toBe("Bench C");
    // Main Store items appear after, in vignette-alpha order
    const osRows = dataRows.filter((r) => r[0] === "Main Store");
    expect(osRows.map((r) => r[1])).toEqual(["Vignette 1", "Vignette 1", "Vignette 2"]);
  });

  it("falls back to '(unassigned)' / '(no vignette)' for missing values", () => {
    const items: WorkbookItem[] = [
      {
        ...baseItem,
        storeLocationName: null,
        storeLocationCode: null,
        vignette: null,
      },
    ];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets["Floor Plan"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(rows[1]?.[0]).toBe("(unassigned)");
    expect(rows[1]?.[1]).toBe("(no vignette)");
  });

  it("flags Stocking items in the Floor Plan as well", () => {
    const items: WorkbookItem[] = [{ ...baseItem, stockProgram: true }];
    const wb = buildBuyerWorkbook(items);
    const ws = wb.Sheets["Floor Plan"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(rows[1]?.[5]).toBe("Stocking");
  });
});

// ─── Buys summary sheet (slice 4-buys) ─────────────────────────────────

describe("buildBuyerWorkbook — Buys sheet", () => {
  it("is omitted when no buys are passed", () => {
    const wb = buildBuyerWorkbook([baseItem]);
    expect(wb.Sheets.Buys).toBeUndefined();
  });

  it("renders one row per Buy with budget vs spent rollup", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, qty: 2, cost: 100, buyName: "Spring 2026" }, // $200 in Spring
      { ...baseItem, qty: 1, cost: 50, buyName: "Spring 2026" }, // +$50 Spring → $250
      { ...baseItem, qty: 1, cost: 1000, buyName: "Fall 2026" }, // $1000 Fall
    ];
    const wb = buildBuyerWorkbook(items, {
      buys: [
        { name: "Spring 2026", season: "Spring", year: 2026, status: "PLANNING", budget: 500 },
        { name: "Fall 2026", season: "Fall", year: 2026, status: "OPEN", budget: 800 },
      ],
    });
    const ws = wb.Sheets.Buys!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const spring = rows.find((r) => (r as unknown[])[0] === "Spring 2026") as unknown[];
    const fall = rows.find((r) => (r as unknown[])[0] === "Fall 2026") as unknown[];

    // Header + Spring + Fall + (no unassigned) + blank + total = 5+ rows
    expect(spring[1]).toBe("Spring"); // season
    expect(spring[2]).toBe(2026); // year
    expect(spring[3]).toBe("PLANNING"); // status
    expect(spring[4]).toBe(500); // budget
    expect(spring[5]).toBe(250); // spent
    expect(spring[6]).toBe(250); // remaining
    expect(spring[7]).toBe(""); // not over

    expect(fall[5]).toBe(1000); // spent
    expect(fall[6]).toBe(-200); // remaining (over budget)
    expect(fall[7]).toBe("OVER"); // flagged
  });

  it("emits an Unassigned row for items not bucketed into any Buy", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, qty: 1, cost: 100, buyName: "Spring 2026" },
      { ...baseItem, qty: 2, cost: 50, buyName: null }, // floating
    ];
    const wb = buildBuyerWorkbook(items, {
      buys: [
        { name: "Spring 2026", season: "Spring", year: 2026, status: "PLANNING", budget: null },
      ],
    });
    const ws = wb.Sheets.Buys!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const unassigned = rows.find((r) => (r as unknown[])[0] === "(Unassigned)") as unknown[];
    expect(unassigned).toBeDefined();
    expect(unassigned[5]).toBe(100); // spent = 2*50
    expect(unassigned[9]).toBe(1); // 1 item
  });

  it("skips the Unassigned row when every item has a Buy", () => {
    const items: WorkbookItem[] = [{ ...baseItem, qty: 1, cost: 100, buyName: "Spring 2026" }];
    const wb = buildBuyerWorkbook(items, {
      buys: [{ name: "Spring 2026", season: null, year: null, status: "OPEN", budget: null }],
    });
    const ws = wb.Sheets.Buys!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const unassigned = rows.find((r) => (r as unknown[])[0] === "(Unassigned)");
    expect(unassigned).toBeUndefined();
  });

  it("emits a TOTAL row at the bottom summing across buys + unassigned", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, qty: 1, cost: 100, buyName: "Spring 2026" },
      { ...baseItem, qty: 1, cost: 50, buyName: null },
    ];
    const wb = buildBuyerWorkbook(items, {
      buys: [{ name: "Spring 2026", season: "Spring", year: 2026, status: "OPEN", budget: 500 }],
    });
    const ws = wb.Sheets.Buys!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const totalRow = rows.find((r) => (r as unknown[])[0] === "TOTAL") as unknown[];
    expect(totalRow).toBeDefined();
    expect(totalRow[5]).toBe(150); // 100 (Spring) + 50 (unassigned)
    expect(totalRow[6]).toBe(350); // 500 budget - 150 spent
  });

  it("counts distinct PO references per Buy", () => {
    const items: WorkbookItem[] = [
      { ...baseItem, qty: 1, cost: 50, buyName: "Spring 2026", poReference: "PON-A" },
      { ...baseItem, qty: 1, cost: 50, buyName: "Spring 2026", poReference: "PON-A" }, // dup
      { ...baseItem, qty: 1, cost: 50, buyName: "Spring 2026", poReference: "PON-B" },
    ];
    const wb = buildBuyerWorkbook(items, {
      buys: [{ name: "Spring 2026", season: null, year: null, status: "OPEN", budget: null }],
    });
    const ws = wb.Sheets.Buys!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    const spring = rows.find((r) => (r as unknown[])[0] === "Spring 2026") as unknown[];
    expect(spring[8]).toBe(2); // distinct POs (PON-A + PON-B)
    expect(spring[9]).toBe(3); // total items
  });
});
