// /app/__tests__/detailedSalesVendorPivot.test.ts
//
// Tripwires for the 2026-04-30 Detailed Sales vendor-pivot work.
//
// Source-text scans (B-grade per Phase 0.6 grading) — the underlying
// behavior is straightforward Prisma + JS rollup; the regression risks
// these tests are designed to catch are:
//
//   1. Someone strips the cancelled-line filter (CLAUDE.md rule 33)
//      from either the summary or the drilldown
//   2. Someone removes the vendor join from the Product select on the
//      summary (would break vendor-pivot rollups silently)
//   3. Someone changes the response shape for DetailedSalesRow without
//      updating the export endpoint or the page
//
// Migration note (App Router + tRPC): the summary + drilldown query logic
// moved verbatim into src/lib/reports/detailedSales.ts (getDetailedSales +
// getDetailedSalesItems); the page UI moved to the App Router client view
// src/app/(dashboard)/app/reports/detailed-sales/DetailedSalesView.tsx. The CSV
// export stays a REST route (detailed-sales/export.ts) but now delegates to the
// shared lib instead of calling the deleted Pages handlers in-process. The
// assertions below were repointed at those new files; the regression intent is
// unchanged.

import { readFileSync } from "fs";
import { join } from "path";

function readSource(...parts: string[]): string {
  return readFileSync(join(__dirname, ...parts), "utf8");
}

const LIB = readSource("..", "src", "lib", "reports", "detailedSales.ts");
const EXPORT_API = readSource(
  "..",
  "src",
  "pages",
  "api",
  "reports",
  "detailed-sales",
  "export.ts",
);
const VIEW = readSource(
  "..",
  "src",
  "app",
  "(dashboard)",
  "app",
  "reports",
  "detailed-sales",
  "DetailedSalesView.tsx",
);

describe("detailed-sales summary lib — vendor pivot extension", () => {
  it("DetailedSalesRow exposes vendor field", () => {
    expect(LIB).toMatch(/vendor:\s*string/);
  });

  it("Product select includes vendor.name (rule 49: vendor join is mandatory for pivot)", () => {
    expect(LIB).toMatch(/vendor:\s*\{\s*select:\s*\{\s*name:\s*true\s*\}\s*\}/);
  });

  it("rule 33: cancelled lines excluded from rollup", () => {
    expect(LIB).toMatch(/lineItemStatus:\s*\{\s*not:\s*"CANCELLED"\s*\}/);
  });

  it("vendors filter parsed and applied through product relation", () => {
    expect(LIB).toMatch(/vendorNames/);
    // Either object-literal `vendor: { name: ... }` or assignment
    // `productFilter.vendor = { name: ... }` is acceptable.
    expect(LIB).toMatch(/vendor\s*[:=]\s*\{\s*name:\s*\{\s*in:\s*vendorNames\s*\}\s*\}/);
  });

  it("group key uses store|dept|cat|vendor (4 dimensions)", () => {
    expect(LIB).toMatch(/`\$\{store\}\|\$\{dept\}\|\$\{cat\}\|\$\{vendor\}`/);
  });
});

describe("detailed-sales drilldown lib — vendor + type narrowing", () => {
  it("accepts a vendor param", () => {
    expect(LIB).toMatch(/params\.vendor/);
  });

  it("accepts a type param", () => {
    expect(LIB).toMatch(/params\.type/);
  });

  it("layers vendor + type onto product filter", () => {
    expect(LIB).toMatch(/productFilter\.vendor/);
    expect(LIB).toMatch(/productFilter\.type/);
  });

  it("response shape includes typeName + vendorName", () => {
    expect(LIB).toMatch(/typeName:\s*string\s*\|\s*null/);
    expect(LIB).toMatch(/vendorName:\s*string\s*\|\s*null/);
  });

  it("rule 33: cancelled lines excluded from drilldown", () => {
    // Two inline occurrences: one in getDetailedSales, one in
    // getDetailedSalesItems. Both must carry the filter so summary +
    // drilldown can never diverge ($405 discrepancy 2026-04-25).
    const matches = LIB.match(/lineItemStatus:\s*\{\s*not:\s*"CANCELLED"\s*\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("detailed-sales/export.ts — CSV export", () => {
  it("declares two levels: group and items", () => {
    expect(EXPORT_API).toMatch(/type Level\s*=\s*"group"\s*\|\s*"items"/);
  });

  it("delegates to the shared report lib (rewired off the deleted in-process handlers)", () => {
    expect(EXPORT_API).toMatch(/getDetailedSales\b/);
    expect(EXPORT_API).toMatch(/getDetailedSalesItems\b/);
    expect(EXPORT_API).toMatch(/from\s+"@\/lib\/reports\/detailedSales"/);
  });

  it("group-level CSV has vendor column", () => {
    expect(EXPORT_API).toMatch(/"Store",\s*"Department",\s*"Category",\s*"Vendor"/);
  });

  it("items-level CSV has vendor + type columns", () => {
    expect(EXPORT_API).toMatch(/"Vendor"/);
    expect(EXPORT_API).toMatch(/"Type"/);
  });

  it("imports csv helpers from the shared lib (extracted 2026-04-30 to clear duplication)", () => {
    // RFC 4180 escaping lives in lib/csvExport.ts; the export endpoint
    // just imports csvRow from there.
    expect(EXPORT_API).toMatch(/from\s+"@\/lib\/csvExport"/);
  });

  it("emits text/csv content type with attachment disposition", () => {
    expect(EXPORT_API).toMatch(/text\/csv/);
    expect(EXPORT_API).toMatch(/Content-Disposition.*attachment/);
  });
});

describe("detailed-sales view — pivot toggle + supplier rollup", () => {
  it("Pivot type allows department or vendor", () => {
    expect(VIEW).toMatch(/type Pivot\s*=\s*"department"\s*\|\s*"vendor"/);
  });

  it("vendorBreakdown memo builds the vendor → dept → category rollup", () => {
    expect(VIEW).toMatch(/vendorBreakdown/);
  });

  it("renders SupplierPivotView when pivot === 'vendor'", () => {
    expect(VIEW).toMatch(/pivot === "vendor" && \(\s*<SupplierPivotView/);
  });

  it("renders department breakdown only when pivot === 'department'", () => {
    expect(VIEW).toMatch(/pivot === "department" &&\s*Array\.from\(storeBreakdown/);
  });

  it("Export CSV button hits the export endpoint", () => {
    expect(VIEW).toMatch(/\/api\/reports\/detailed-sales\/export/);
  });
});
