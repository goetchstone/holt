// /app/src/lib/buyerDraftWorkbook.ts
//
// Pure helper that turns a flat list of `BuyerDraftItem` rows into an
// XLSX workbook matching the buyer's existing OTB workbook shape.
//
// Three sheet types:
//
//   1. TOTAL — pivot summary by vendor × month (ship month). Mirrors the
//      "TOTAL" sheet in the OTB workbook.
//   2. Per-vendor — one sheet per supplier with the columns the buyer is
//      used to: Item# / Item Name / Description / Qty / Cost / Total Cost /
//      MSRP / Retail / Total Retail / SKU# / PON.
//   3. Floor Plan — per-vignette grouping inside each store location, with
//      Qty to Order column. Mirrors the "OS Floor" sheet.
//
// The workbook is keyed by raw values (no FK ids, no Decimal blobs); the
// API endpoint hydrates these from Prisma rows before calling.
//
// Pure — no I/O, no Prisma. Tested in
// `__tests__/buyerDraftWorkbook.test.ts` against fixture rows.

import * as XLSX from "xlsx";
import { parseShipMonth } from "@/lib/buyPerformanceWindow";

// ─── Input shapes ──────────────────────────────────────────────────────

export interface WorkbookItem {
  // Identity
  partNumber: string;
  productName: string;
  // Description column — already assembled / chosen by the caller.
  // (XLSX cells render newlines fine if the cell is wrapText-styled.)
  description: string | null;
  // Barcode / UPC (2026-05-13). Populated for items added via the
  // barcode-lookup quick-add modal, where the scanned UPC is the
  // canonical identifier the buyer used. Per-vendor sheet shows this
  // in a new "Barcode" column so the buyer can match against the
  // physical tags / inbound packing lists.
  barcode: string | null;
  // Money + qty
  qty: number;
  cost: number;
  msrp: number | null;
  retail: number;
  // Linkage / refs
  sku: string | null; // the POS SKU once it's been imported back
  poReference: string | null; // PON
  // Grouping
  supplierName: string;
  storeLocationName: string | null; // e.g. "Main Showroom"
  storeLocationCode: string | null; // e.g. "OS"
  vignette: string | null;
  // Stock program flag — drives whether the per-vendor sheet's row
  // shows a "Stocking" tag or not (matches OTB convention).
  stockProgram: boolean;
  // Expected ship month — drives the TOTAL pivot column. Accepts:
  //  - Date (post-2026-05-13 DateTime promotion; first-of-month UTC)
  //  - YYYY-MM string (canonical legacy / iPad input)
  //  - MM-YYYY string (iPad-Safari quirk)
  //  - null → "Unscheduled" bucket
  // `expectedShipMonthToMonthName` handles all four shapes and
  // returns the canonical long month-name key.
  expectedShipMonth: Date | string | null;
  // Buy linkage (slice 4-buys, 2026-05-09). Items inherit their Buy
  // through the PO they're attached to. May be null when the item's
  // PO has no Buy assigned, or the item has no PO yet.
  buyName: string | null;
}

/** Pure helper — turn an expectedShipMonth value into the long
 *  English month name ("January", "September", …) for use as the
 *  TOTAL-pivot column key. Accepts Date (post-DateTime promotion),
 *  YYYY-MM string, MM-YYYY string, or any shape the shared
 *  `parseShipMonth` helper recognizes. Returns "Unscheduled" for
 *  null / unparseable input. */
export function expectedShipMonthToMonthName(raw: Date | string | null): string {
  if (raw === null || raw === undefined) return "Unscheduled";
  const d = raw instanceof Date ? raw : parseShipMonth(raw);
  if (d === null || Number.isNaN(d.getTime())) return "Unscheduled";
  return d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
}

/** Aggregate Buy data for the Buys summary sheet. Driven by the
 * BuyerDraftBuy parent table — what the buyer plans against. */
export interface WorkbookBuy {
  name: string;
  season: string | null;
  year: number | null;
  status: string;
  budget: number | null;
}

export interface BuildWorkbookOptions {
  /** Workbook title shown in the Properties pane. */
  title?: string;
  /** Author shown in the Properties pane. */
  author?: string;
  /** Sheet order (TOTAL pivot first, per-vendor sheets sorted alphabetically by default). */
  vendorSheetOrder?: "alphabetical" | "by-total-cost-desc";
  /** Whether to include a Floor Plan sheet at the end. Default: true. */
  includeFloorPlan?: boolean;
  /** Months to use as TOTAL pivot columns. Default: standard 12. */
  pivotMonths?: readonly string[];
  /** Buys to include in the per-Buy summary sheet. If empty / omitted,
   *  the Buys sheet is skipped (slice 4-buys, 2026-05-09). */
  buys?: readonly WorkbookBuy[];
}

// ─── Column shapes ─────────────────────────────────────────────────────

// Per-vendor sheet — match the buyer's OTB workbook columns exactly.
// "Barcode" added 2026-05-13 for barcode-lookup-created items where
// the UPC is the canonical identifier the buyer used.
export const VENDOR_SHEET_HEADERS = [
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
] as const;

// TOTAL pivot — Vendor name in column A, then one column per month, then TOTAL.
export const DEFAULT_PIVOT_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const FLOOR_PLAN_HEADERS = [
  "Location",
  "Vignette",
  "Item",
  "Supplier",
  "Qty",
  "Stocking",
] as const;

// Buys summary sheet (slice 4-buys, 2026-05-09). One row per Buy:
//   identity columns + budget tracking + item/PO counts.
// Items not assigned to any Buy roll up into a synthetic "(Unassigned)"
// row at the bottom so the buyer sees what's still drifting.
export const BUYS_SHEET_HEADERS = [
  "Buy",
  "Season",
  "Year",
  "Status",
  "Budget",
  "Spent",
  "Remaining",
  "Over?",
  "POs",
  "Items",
] as const;

// ─── Build entry point ─────────────────────────────────────────────────

export function buildBuyerWorkbook(
  items: readonly WorkbookItem[],
  options: BuildWorkbookOptions = {},
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  if (options.title) wb.Props = { Title: options.title };
  if (options.author) wb.Props = { ...wb.Props, Author: options.author };

  // Sheet 1: TOTAL pivot
  XLSX.utils.book_append_sheet(
    wb,
    buildTotalPivotSheet(items, options.pivotMonths ?? DEFAULT_PIVOT_MONTHS),
    "TOTAL",
  );

  // Sheets 2..N: per-vendor
  const vendors = collectVendorOrder(items, options.vendorSheetOrder ?? "alphabetical");
  for (const vendorName of vendors) {
    const vendorItems = items.filter((it) => it.supplierName === vendorName);
    XLSX.utils.book_append_sheet(
      wb,
      buildVendorSheet(vendorItems),
      // Excel sheet names are capped at 31 chars and can't contain : \ / ? * [ ]
      sanitizeSheetName(vendorName),
    );
  }

  // Buys summary sheet (slice 4-buys). Sits between TOTAL and the
  // per-vendor sheets in spreadsheet apps that show tabs alphabetically;
  // we append it BEFORE Floor Plan so it lands right after the per-vendor
  // sheets when the buyer reads left-to-right.
  if (options.buys && options.buys.length > 0) {
    XLSX.utils.book_append_sheet(wb, buildBuysSheet(items, options.buys), "Buys");
  }

  // Last sheet: Floor Plan (optional)
  if (options.includeFloorPlan ?? true) {
    XLSX.utils.book_append_sheet(wb, buildFloorPlanSheet(items), "Floor Plan");
  }

  return wb;
}

// ─── Buys summary (slice 4-buys) ───────────────────────────────────────

/** Compute the spent-vs-budget rollup per Buy from the items list, plus
 * a synthetic "(Unassigned)" row for items whose PO has no Buy.
 *
 * Pure — no I/O. Uses each item's `buyName` to attribute spend.
 */
// Aggregate per-Buy spend/count/PO refs from the items list. Pure helper,
// extracted so buildBuysSheet stays simple (Sonar S3776).
interface BuyAggregates {
  spent: Map<string, number>;
  itemCount: Map<string, number>;
  poRefs: Map<string, Set<string>>;
}

function aggregateByBuy(items: readonly WorkbookItem[]): BuyAggregates {
  const spent = new Map<string, number>();
  const itemCount = new Map<string, number>();
  const poRefs = new Map<string, Set<string>>();

  for (const item of items) {
    const key = item.buyName ?? "(Unassigned)";
    spent.set(key, (spent.get(key) ?? 0) + item.qty * item.cost);
    itemCount.set(key, (itemCount.get(key) ?? 0) + 1);
    if (item.poReference) {
      if (!poRefs.has(key)) poRefs.set(key, new Set());
      poRefs.get(key)!.add(item.poReference);
    }
  }

  return { spent, itemCount, poRefs };
}

// Build one data row per Buy. Positive (b.budget === null) idiom for
// "no budget set" keeps the conditions readable (Sonar S7735).
function buildBuyRow(b: WorkbookBuy, agg: BuyAggregates): (string | number)[] {
  const s = agg.spent.get(b.name) ?? 0;
  const budget = b.budget;
  const remaining = budget === null ? "" : budget - s;
  const overFlag = budget !== null && s > budget ? "OVER" : "";
  return [
    b.name,
    b.season ?? "",
    b.year ?? "",
    b.status,
    b.budget ?? "",
    s,
    remaining,
    overFlag,
    agg.poRefs.get(b.name)?.size ?? 0,
    agg.itemCount.get(b.name) ?? 0,
  ];
}

function buildBuysSheet(
  items: readonly WorkbookItem[],
  buys: readonly WorkbookBuy[],
): XLSX.WorkSheet {
  const agg = aggregateByBuy(items);

  const dataRows: (string | number)[][] = [];
  for (const b of buys) {
    dataRows.push(buildBuyRow(b, agg));
  }

  // Synthetic Unassigned row at the bottom — surfaces items the buyer
  // hasn't yet bucketed into a Buy. Only emit if there's something to show.
  const unassignedSpend = agg.spent.get("(Unassigned)") ?? 0;
  if (unassignedSpend > 0 || (agg.itemCount.get("(Unassigned)") ?? 0) > 0) {
    dataRows.push([
      "(Unassigned)",
      "",
      "",
      "—",
      "",
      unassignedSpend,
      "",
      "",
      agg.poRefs.get("(Unassigned)")?.size ?? 0,
      agg.itemCount.get("(Unassigned)") ?? 0,
    ]);
  }

  // TOTAL row — sum across all rows.
  let totalSpent = 0;
  let totalBudget = 0;
  let hasBudget = false;
  for (const b of buys) {
    if (b.budget !== null) {
      totalBudget += b.budget;
      hasBudget = true;
    }
    totalSpent += agg.spent.get(b.name) ?? 0;
  }
  totalSpent += unassignedSpend;

  const totalRow = [
    "TOTAL",
    "",
    "",
    "",
    hasBudget ? totalBudget : "",
    totalSpent,
    hasBudget ? totalBudget - totalSpent : "",
    hasBudget && totalSpent > totalBudget ? "OVER" : "",
    "",
    "",
  ];

  return XLSX.utils.aoa_to_sheet([[...BUYS_SHEET_HEADERS], ...dataRows, [], totalRow]);
}

// ─── TOTAL pivot ───────────────────────────────────────────────────────

function buildTotalPivotSheet(
  items: readonly WorkbookItem[],
  months: readonly string[],
): XLSX.WorkSheet {
  // rows[vendor][month] = total cost. Map raw YYYY-MM / MM-YYYY ship
  // months to month names ("January", "February", …) so they line up
  // with the pivot column headers. Anything unparseable → "Unscheduled".
  const rows = new Map<string, Map<string, number>>();
  for (const item of items) {
    const monthKey = expectedShipMonthToMonthName(item.expectedShipMonth);
    const totalCost = item.qty * item.cost;
    if (!rows.has(item.supplierName)) rows.set(item.supplierName, new Map());
    const m = rows.get(item.supplierName)!;
    m.set(monthKey, (m.get(monthKey) ?? 0) + totalCost);
  }

  const sortedVendors = [...rows.keys()].sort((a, b) => a.localeCompare(b));
  const monthSet = new Set<string>(months);
  const usedExtraMonths = new Set<string>();
  for (const m of rows.values()) {
    for (const k of m.keys()) {
      if (!monthSet.has(k)) usedExtraMonths.add(k);
    }
  }
  const allMonths = [...months, ...[...usedExtraMonths].sort((a, b) => a.localeCompare(b))];

  const headerRow = ["Vendor", ...allMonths, "TOTAL"];
  const dataRows: (string | number)[][] = sortedVendors.map((vendor) => {
    const monthMap = rows.get(vendor)!;
    const monthCells = allMonths.map((m) => monthMap.get(m) ?? 0);
    const total = monthCells.reduce((acc, n) => acc + n, 0);
    return [vendor, ...monthCells, total];
  });

  // Grand-total row at the bottom
  const grandTotal = allMonths.map((m) => {
    let sum = 0;
    for (const monthMap of rows.values()) sum += monthMap.get(m) ?? 0;
    return sum;
  });
  const grandTotalSum = grandTotal.reduce((a, b) => a + b, 0);
  const totalRow: (string | number)[] = ["TOTAL", ...grandTotal, grandTotalSum];

  return XLSX.utils.aoa_to_sheet([headerRow, ...dataRows, [], totalRow]);
}

// ─── Per-vendor sheet ──────────────────────────────────────────────────

function buildVendorSheet(items: readonly WorkbookItem[]): XLSX.WorkSheet {
  const data: (string | number | null)[][] = [[...VENDOR_SHEET_HEADERS]];

  // One row per item. Total Cost / Total Retail are computed (not formulas)
  // to keep the export portable across Excel / Numbers / Sheets.
  for (const item of items) {
    const totalCost = round2(item.qty * item.cost);
    const totalRetail = round2(item.qty * item.retail);
    data.push([
      item.partNumber,
      item.productName,
      item.description ?? "",
      item.barcode ?? "",
      item.qty,
      round2(item.cost),
      totalCost,
      item.msrp === null ? null : round2(item.msrp),
      round2(item.retail),
      totalRetail,
      item.sku ?? "",
      item.poReference ?? "",
      item.stockProgram ? "Stocking" : "",
    ]);
  }

  // Subtotal row at the bottom (sum of Total Cost + Total Retail).
  if (items.length > 0) {
    const subtotalCost = items.reduce((acc, i) => acc + i.qty * i.cost, 0);
    const subtotalRetail = items.reduce((acc, i) => acc + i.qty * i.retail, 0);
    // Spacer + TOTAL row. Layout matches VENDOR_SHEET_HEADERS (13
    // columns with Barcode inserted at index 3). TOTAL aligned under
    // Qty; cost subtotal under Total Cost; retail subtotal under
    // Total Retail.
    data.push(
      [],
      [
        "",
        "",
        "",
        "",
        "TOTAL",
        "",
        round2(subtotalCost),
        "",
        "",
        round2(subtotalRetail),
        "",
        "",
        "",
      ],
    );
  }

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Suggest reasonable column widths so the buyer doesn't have to resize
  // every column on first open. Values are character-units, not pixels.
  ws["!cols"] = [
    { wch: 14 }, // Item#
    { wch: 24 }, // Item Name
    { wch: 60 }, // Description (multi-line; wide)
    { wch: 16 }, // Barcode
    { wch: 6 }, // Qty
    { wch: 9 }, // Cost
    { wch: 11 }, // Total Cost
    { wch: 9 }, // MSRP
    { wch: 9 }, // Retail
    { wch: 12 }, // Total Retail
    { wch: 12 }, // SKU#
    { wch: 14 }, // PON
    { wch: 11 }, // Stocking
  ];

  return ws;
}

// ─── Floor plan sheet ──────────────────────────────────────────────────

function buildFloorPlanSheet(items: readonly WorkbookItem[]): XLSX.WorkSheet {
  // Group: Location → Vignette → items.
  const grouped = new Map<string, Map<string, WorkbookItem[]>>();
  for (const item of items) {
    const loc = item.storeLocationName ?? item.storeLocationCode ?? "(unassigned)";
    const vig = item.vignette ?? "(no vignette)";
    if (!grouped.has(loc)) grouped.set(loc, new Map());
    const vMap = grouped.get(loc)!;
    if (!vMap.has(vig)) vMap.set(vig, []);
    vMap.get(vig)!.push(item);
  }

  const data: (string | number | null)[][] = [[...FLOOR_PLAN_HEADERS]];

  const sortedLocs = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  for (const loc of sortedLocs) {
    const vMap = grouped.get(loc)!;
    const sortedVigs = [...vMap.keys()].sort((a, b) => a.localeCompare(b));
    for (const vig of sortedVigs) {
      const vigItems = vMap.get(vig)!;
      for (const item of vigItems) {
        data.push([
          loc,
          vig,
          item.productName,
          item.supplierName,
          item.qty,
          item.stockProgram ? "Stocking" : "",
        ]);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = [
    { wch: 18 }, // Location
    { wch: 22 }, // Vignette
    { wch: 28 }, // Item
    { wch: 18 }, // Supplier
    { wch: 6 }, // Qty
    { wch: 11 }, // Stocking
  ];
  return ws;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function collectVendorOrder(
  items: readonly WorkbookItem[],
  order: "alphabetical" | "by-total-cost-desc",
): string[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.supplierName, (totals.get(item.supplierName) ?? 0) + item.qty * item.cost);
  }
  const vendors = [...totals.keys()];
  if (order === "by-total-cost-desc") {
    return vendors.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  }
  return vendors.sort((a, b) => a.localeCompare(b));
}

/**
 * Excel sheet names: max 31 chars, no `: \ / ? * [ ]`. We replace illegal
 * chars with `_` and truncate to 31 chars. Falls back to "Vendor" if the
 * input is empty.
 */
export function sanitizeSheetName(raw: string): string {
  const trimmed = raw.trim() || "Vendor";
  const replaced = trimmed.replaceAll(/[:\\/?*[\]]/g, "_");
  return replaced.length > 31 ? replaced.slice(0, 31) : replaced;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
