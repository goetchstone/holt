// /app/__tests__/revenueScopeSingleSource.test.ts
//
// Companion to salesRevenueStatusesSingleSource.test.ts, catching the OPPOSITE
// failure.
//
// That test catches a report that spells `["ORDER", "FULFILLED", "RETURNED"]`
// itself instead of importing the constant -- duplication. This one catches a
// report that never constrains `SalesOrder.status` AT ALL -- omission.
//
// Omission is the one that actually shipped. Four raw-SQL reports joined
// SalesOrder, filtered cancelled LINES (rule 33, which has a tripwire and so
// gets remembered), and then summed `netPrice` across every order status:
//
//   grossMargin.ts     revenue, cost and margin by department/vendor
//   topSellers.ts      the reorder / clear-out ranking
//   factSalesDay.ts    daily sales by department -- and no date bound either
//   inventoryHealth.ts last_sold, so quoted stock looked freshly sold
//
// QUOTE and DRAFT orders counted as revenue in all four. Nothing failed and no
// number looked obviously wrong; they simply did not reconcile against Detailed
// Sales, and nobody had a reason to check. Rule 33 was enforced by a test and
// the revenue-status rule was enforced by memory, so the two rules drifted
// exactly as far apart as that difference predicts.
//
// SCOPE, stated honestly: this is a FILE-level check. A file with two SalesOrder
// joins where only one is constrained will pass. Making it per-query would mean
// parsing SQL, and a guard that is clever is a guard that gets muted the first
// time it is wrong. It catches "forgot entirely", which is the failure that
// actually happened four times.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const APP_DIR = join(__dirname, "..");

/**
 * An actual IMPORT of the shared predicate, not a mention of its name.
 *
 * This started as `text.includes("revenueStatusSql")`, which the first
 * both-directions check caught immediately: reverting grossMargin.ts to its
 * buggy state left the helper's name in a header comment, and the guard passed.
 * A guard a comment can satisfy is already muted.
 */
const HELPER_IMPORT = 'from "@/lib/reports/revenueScope"';

/** A real call, not the word. */
const HELPER_CALL = /\brevenueStatusSql\s*\(/;

/**
 * Files that join SalesOrder in raw SQL but legitimately need NO order-status
 * predicate. Empty today, and it should stay that way -- a genuine exemption is
 * rare enough to deserve an argument in review, which is the point of listing
 * them here by name rather than pattern-matching them away.
 */
const EXEMPT: string[] = [];

function filesJoiningSalesOrder(): string[] {
  try {
    const out = execFileSync("grep", ["-rlF", 'JOIN "SalesOrder"', "src"], {
      cwd: APP_DIR,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean).sort();
  } catch (err: unknown) {
    // grep exits 1 with no output when nothing matches.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

function fileText(rel: string): string {
  return execFileSync("cat", [rel], { cwd: APP_DIR, encoding: "utf8" });
}

/**
 * Does this file constrain SalesOrder.status anywhere? Accepts the shared
 * helper, the canonical constant, or an inline predicate -- an inline one is
 * legal when deliberately narrower (see lib/salesOrderRevenue.ts's header;
 * inventoryHealth.ts's last_sold and crossSell.ts are both real cases).
 */
function constrainsOrderStatus(text: string): boolean {
  if (text.includes(HELPER_IMPORT) && HELPER_CALL.test(text)) return true;
  if (text.includes("SALES_REVENUE_STATUSES")) return true;
  // An inline predicate: `so.status IN (...)`, `so."status" = ...`. Anchored on
  // a bare `status` column so `li."lineItemStatus" <> 'CANCELLED'` -- which
  // every one of the four offenders already had -- cannot satisfy it.
  return /\b[a-z][a-z0-9_]*\.\s*"?status"?\s*(IN|=|<>|!=)/i.test(text);
}

describe("raw-SQL reports constrain SalesOrder.status", () => {
  it("every file joining SalesOrder in raw SQL filters order status", () => {
    const offenders = filesJoiningSalesOrder()
      .filter((f) => !EXEMPT.includes(f))
      .filter((f) => !constrainsOrderStatus(fileText(f)));

    expect(offenders).toEqual([]);
  });

  it("the shared helper is the only place the raw-SQL status list is built", () => {
    const owner = "src/lib/reports/revenueScope.ts";
    const text = fileText(owner);
    // It must derive from the canonical constant, never restate the values.
    expect(text).toContain("SALES_REVENUE_STATUSES");
    expect(text).not.toContain("'ORDER'");
    expect(text).not.toContain('"ORDER"');
  });

  it("EXEMPT entries all still exist (a stale exemption silently un-guards a file)", () => {
    const present = filesJoiningSalesOrder();
    for (const e of EXEMPT) expect(present).toContain(e);
  });
});
