// /app/__tests__/reports.cancelledLineFilter.test.ts
//
// PLACEHOLDER TEST -- Grade: B- (source-text tripwire)
//
// CLAUDE.md rule 33: every report and accounting aggregation that sums
// OrderLineItem amounts must filter out lineItemStatus = "CANCELLED".
// The sales import marks orphaned line items CANCELLED (PR #121, was
// deleteMany before -- see importRunners.ts), so any aggregation
// that omits the filter silently inflates totals.
//
// These are source-text tripwires. They don't run the queries; they assert
// that the filter is present in each surface that reads OrderLineItem for
// dollar aggregation. If you add a new report or another consumer of line
// items for sums, add it to the list below -- that's the whole point.
//
// Upgrade target: NONE -- Phase 0.6 plan explicitly keeps this at B-.
// The bug class is "developer forgets to add the filter," and a source-text
// scan catches that perfectly. A real-DB equivalent would re-test what
// Postgres already guarantees (a `not: "CANCELLED"` clause does what it
// says) without catching anything new. See plan section "Phase 0.6 --
// Test infrastructure roadmap" for the rationale.

import fs from "node:fs";
import path from "node:path";

const APP_ROOT = path.join(__dirname, "..");
const REPORTS_DIR = path.join(APP_ROOT, "src", "pages", "api", "reports");

function read(file: string): string {
  return fs.readFileSync(path.join(REPORTS_DIR, file), "utf8");
}

function readApp(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), "utf8");
}

const ENDPOINTS_THAT_SUM_LINE_ITEMS: ReadonlyArray<{ file: string; description: string }> = [
  // detailed-sales (summary + drilldown) fully ported to App Router + tRPC; both
  // filters now live in src/lib/reports/detailedSales.ts (inline
  // `lineItemStatus: { not: "CANCELLED" }` in getDetailedSales AND
  // getDetailedSalesItems), asserted by the LIB_REPORTS auto-discover check
  // below and the same-filter-shape test. The export.ts REST shim delegates to
  // the same lib.
  // sales-daily fully ported to App Router + tRPC; its filter now lives in
  // src/lib/reports/salesDaily.ts, asserted by the LIB_REPORTS check below.
  { file: "factsalesday.ts", description: "daily sales by department" },
  // sales-by-salesperson (summary + drilldown) fully ported to App Router +
  // tRPC; both filters now live in src/lib/reports/salesBySalespersonReport.ts
  // (via buildLineItemWhere), asserted by the LIB_REPORTS auto-discover check
  // below. The export.ts REST shim delegates to the same lib.
  // salesperson-detail fully ported to App Router + tRPC; its filter now lives
  // in src/lib/reports/salespersonDetail.ts (via buildLineItemWhere), asserted
  // by the LIB_REPORTS check below.
  // monthly-performance fully ported to App Router + tRPC; its filter now lives
  // in src/lib/reports/monthlyPerformance.ts (via buildLineItemWhere), asserted
  // by the LIB_REPORTS check below.
  // designer-dashboard fully ported to App Router + tRPC; its filter now lives
  // in src/lib/reports/designerDashboard.ts (via buildLineItemWhere), asserted
  // by the LIB_REPORTS check below.
];

// Files that own a centralized line-item where-clause helper. If an
// endpoint imports one of these (instead of writing the filter inline)
// the test verifies the helper itself contains the filter. This lets
// shared business logic deduplicate without breaking the rule-33
// tripwire.
const SHARED_LINE_ITEM_HELPERS: ReadonlyArray<{
  helperFile: string;
  importMarker: RegExp;
}> = [
  {
    helperFile: "src/lib/salesBySalesperson.ts",
    importMarker: /buildLineItemWhere/,
  },
  {
    // App Router migration: factsalesday's logic moved to a shared lib; the
    // REST shim imports it. The filter now lives in the helper.
    helperFile: "src/lib/reports/factSalesDay.ts",
    importMarker: /getFactSalesDay/,
  },
];

const FILTER_REGEX = /lineItemStatus:\s*\{\s*not:\s*["']CANCELLED["']\s*\}/;
// Raw-SQL guard, either inequality operator (Postgres treats <> and != alike).
const RAW_SQL_REGEX = /lineItemStatus.*(?:<>|!=)\s*'CANCELLED'/;

function fileExcludesCancelled(file: string): boolean {
  const src = read(file);
  if (FILTER_REGEX.test(src) || RAW_SQL_REGEX.test(src)) return true;
  for (const { helperFile, importMarker } of SHARED_LINE_ITEM_HELPERS) {
    if (importMarker.test(src)) {
      const helperSrc = readApp(helperFile);
      // Helper may carry the filter as a Prisma clause OR a raw-SQL guard.
      if (FILTER_REGEX.test(helperSrc) || RAW_SQL_REGEX.test(helperSrc)) return true;
    }
  }
  return false;
}

describe("Reports: CANCELLED line item filter (CLAUDE.md rule 33)", () => {
  for (const { file, description } of ENDPOINTS_THAT_SUM_LINE_ITEMS) {
    test(`${file} (${description}) excludes CANCELLED lines`, () => {
      expect(fileExcludesCancelled(file)).toBe(true);
    });
  }

  // Explicit pin so that deletion of the filter from the helper fails
  // loudly here rather than silently weakening every endpoint that
  // delegates to it.
  for (const { helperFile } of SHARED_LINE_ITEM_HELPERS) {
    test(`shared helper ${helperFile} contains the CANCELLED filter`, () => {
      const helperSrc = readApp(helperFile);
      // Prisma clause (salesBySalesperson) OR raw-SQL guard (factSalesDay).
      expect(FILTER_REGEX.test(helperSrc) || RAW_SQL_REGEX.test(helperSrc)).toBe(true);
    });
  }

  test("summary endpoint and drilldown use the same filter shape", () => {
    // If these diverge, the user sees totals that don't reconcile to the
    // sum of the rows when they drill in. That was the $405 Main Store
    // discrepancy reported on 2026-04-25.
    //
    // The summary (getDetailedSales) and drilldown (getDetailedSalesItems) now
    // live in ONE lib file — src/lib/reports/detailedSales.ts — so they cannot
    // structurally diverge the way the two old REST handlers did. We assert the
    // literal filter appears in that single file; since both functions share it
    // there, matching once proves both carry the same shape. (The deleted Pages
    // handlers detailed-sales.ts + detailed-sales/items.ts no longer exist.)
    const lib = readApp("src/lib/reports/detailedSales.ts");
    const matches = lib.match(/lineItemStatus:\s*\{\s*not:\s*"CANCELLED"\s*\}/g) ?? [];
    // One occurrence in getDetailedSales, one in getDetailedSalesItems.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // App Router migration: report data logic moves to src/lib/reports/*. Every
  // such file that reads OrderLineItem for dollar aggregation must carry the
  // CANCELLED filter. This auto-discovers them so a future port can't add a
  // revenue report that silently includes cancelled lines.
  describe("lib/reports/* helpers exclude CANCELLED lines", () => {
    const LIB_REPORTS_DIR = path.join(APP_ROOT, "src", "lib", "reports");
    const libFiles = fs.existsSync(LIB_REPORTS_DIR)
      ? fs.readdirSync(LIB_REPORTS_DIR).filter((f) => f.endsWith(".ts"))
      : [];
    // Reports that read OrderLineItem dollar amounts but legitimately do NOT
    // need the cancelled filter. openOrders aggregates PurchaseOrder.lineItems
    // (no cancelled-status concept) and only reads SalesOrder.totalPaid (not
    // its line items). Document any addition here with the reason.
    const NO_FILTER_NEEDED = new Set(["openOrders.ts"]);
    for (const file of libFiles) {
      if (NO_FILTER_NEEDED.has(file)) continue;
      const src = fs.readFileSync(path.join(LIB_REPORTS_DIR, file), "utf8");
      // Assert on files that aggregate SalesOrder line items.
      const aggregatesSalesLines = /salesOrder/i.test(src) && /lineItems/.test(src);
      if (!aggregatesSalesLines) continue;
      test(`lib/reports/${file} excludes CANCELLED lines`, () => {
        // A file may carry the filter inline (FILTER_REGEX / RAW_SQL_REGEX) OR
        // delegate to buildLineItemWhere, the shared helper pinned to contain
        // the filter by the SHARED_LINE_ITEM_HELPERS test above.
        const usesSharedHelper = /buildLineItemWhere/.test(src);
        expect(FILTER_REGEX.test(src) || RAW_SQL_REGEX.test(src) || usesSharedHelper).toBe(true);
      });
    }
  });

  describe("Accounting / Journal Entry path (B1 from SOR plan, 2026-04-28)", () => {
    // The JE generator is the third surface for this bug class. It sums
    // OrderLineItem.netPrice / cost / vatAmount into the daily journal --
    // if cancelled lines slip through, the books inflate. Same shape as
    // the $405 Detailed Sales bug, third time this surface area has bit.
    test("lib/journalEntry.ts excludes CANCELLED line items at the data-fetch layer", () => {
      const src = readApp("src/lib/journalEntry.ts");
      // The Prisma include for lineItems must carry the lineItemStatus
      // filter. We assert the filter clause is present in the file as a
      // source-text guard; a future refactor that drops it fails this
      // test rather than silently inflating the journal.
      expect(src).toMatch(/lineItemStatus:\s*\{\s*not:\s*["']CANCELLED["']\s*\}/);
    });
  });
});
