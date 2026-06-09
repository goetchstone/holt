// /app/__tests__/reports.salesRevenueStatusFilter.test.ts
//
// PLACEHOLDER TEST -- Grade: B- (source-text tripwire)
//
// 2026-05-13: source-text tripwire for the sister rule to CLAUDE.md
// rule 33. Whereas rule 33 governs `lineItemStatus` (cancelled lines
// must be excluded from sums), THIS rule governs `SalesOrder.status`
// (RETURNED orders must be INCLUDED in customer-revenue sums so the
// negative netPrice rows net out rewrite chains and refunds).
//
// User-reported origin (Barbara Germano, 2026-05-13): the Mailchimp
// Campaign Impact report attributed $88,624 to her engagement when
// her actual net spend was $61,922. The missing $26K was the
// accounting return SR-013491 that the WHERE clause silently
// dropped via `status: { in: ["ORDER", "FULFILLED"] }` (no RETURNED).
//
// Bug shape: any report / aggregation that asks "what did this
// customer spend?" needs `status: { in: ["ORDER", "FULFILLED",
// "RETURNED"] }` so the negative netPrice rows on RETURNED orders
// (accounting-return SR-SAMPLE rows) cancel the corresponding positive
// rows on the base order or its rewrite. The canonical shared
// constant is `SALES_REVENUE_STATUSES` in `lib/salesOrderRevenue.ts`.
//
// Files in REVENUE_AGGREGATION_SURFACES must EITHER use that
// canonical constant OR hard-code `["ORDER", "FULFILLED", "RETURNED"]`.
// Anything else (the buggy `["ORDER", "FULFILLED"]` shape) trips this
// guard.
//
// Upgrade target: NONE — same rationale as cancelledLineFilter.
// The bug class is "developer forgets RETURNED" and a source-text
// scan catches that perfectly. A real-DB equivalent exists for the
// Mailchimp surface (mailchimpAttributionRewriteChain.integration)
// to pin the actual money math, but the broad tripwire belongs here.
//
// If you add a NEW report or aggregation that needs to sum a
// customer's revenue (lifetime spend, campaign attribution, wealth
// segments, level math, etc.), add it to REVENUE_AGGREGATION_SURFACES
// below — that's the whole point.

import fs from "node:fs";
import path from "node:path";

const APP_ROOT = path.join(__dirname, "..");

function readApp(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), "utf8");
}

// Each entry is a file that filters SalesOrder by status as part of
// a customer-revenue calculation. New revenue-shaped reports go here.
const REVENUE_AGGREGATION_SURFACES: ReadonlyArray<{
  file: string;
  description: string;
}> = [
  {
    file: "src/pages/api/mailchimp/campaigns/db.ts",
    description: "Mailchimp Campaign Impact — list endpoint",
  },
  {
    file: "src/pages/api/mailchimp/campaigns/[id].ts",
    description: "Mailchimp Campaign Impact — detail endpoint",
  },
  {
    // Ported to App Router + tRPC; spend rollup now lives in the report lib.
    file: "src/lib/reports/wealthInsights.ts",
    description: "Wealth Insights — per-customer spend rollup",
  },
  {
    file: "src/lib/customerLeveling.ts",
    description: "Customer level recalculation — lifetime + per-group spend math",
  },
];

// Canonical: imports SALES_REVENUE_STATUSES from the shared module.
const CANONICAL_IMPORT_REGEX = /SALES_REVENUE_STATUSES/;

// Acceptable inline form (Prisma WHERE): contains ORDER, FULFILLED,
// AND RETURNED in the same status list. Matches both
// `{ in: ["ORDER", "FULFILLED", "RETURNED"] }` and the spread form.
const INLINE_FULL_LIST_PRISMA =
  /status:\s*\{\s*in:\s*\[[^\]]*"ORDER"[^\]]*"FULFILLED"[^\]]*"RETURNED"/;

// Acceptable raw SQL form: same three values present, any order.
function rawSqlHasAllThree(src: string): boolean {
  const matches = src.match(/status\s+IN\s*\([^)]+\)/gi) ?? [];
  return matches.some((m) => /'ORDER'/.test(m) && /'FULFILLED'/.test(m) && /'RETURNED'/.test(m));
}

function passes(file: string): boolean {
  const src = readApp(file);
  if (CANONICAL_IMPORT_REGEX.test(src)) return true;
  if (INLINE_FULL_LIST_PRISMA.test(src)) return true;
  if (rawSqlHasAllThree(src)) return true;
  return false;
}

describe("revenue-aggregation status filter — tripwire (CLAUDE.md sister rule)", () => {
  for (const surface of REVENUE_AGGREGATION_SURFACES) {
    it(`${surface.description} (${surface.file}) — includes RETURNED in the status filter`, () => {
      expect(passes(surface.file)).toBe(true);
    });
  }

  it("canonical constant file exports SALES_REVENUE_STATUSES with all three values", () => {
    const src = readApp("src/lib/salesOrderRevenue.ts");
    expect(src).toMatch(/SALES_REVENUE_STATUSES/);
    expect(src).toMatch(/"ORDER"/);
    expect(src).toMatch(/"FULFILLED"/);
    expect(src).toMatch(/"RETURNED"/);
  });
});
