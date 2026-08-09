// /app/src/lib/reports/revenueScope.ts
//
// The raw-SQL half of `SALES_REVENUE_STATUSES` (lib/salesOrderRevenue.ts).
//
// Why this exists: the canonical list is a TypeScript tuple, which drops
// straight into a Prisma `where`. It cannot be dropped into a `$queryRaw`
// string, so every raw-SQL report had to spell the statuses out by hand -- and
// three of them simply forgot. `grossMargin.ts`, `topSellers.ts` and
// `factSalesDay.ts` each filtered cancelled LINES (rule 33) and then summed
// `netPrice` across every order status, counting QUOTE and DRAFT orders as
// revenue. None of them reconciled against Detailed Sales, and nothing failed.
//
// That is the same failure shape rule 37 describes, one layer down: the rule
// had one spelling for Prisma callers and no spelling at all for SQL callers,
// so SQL callers were left to remember it. This module is the missing spelling.
//
// Parameterized, not interpolated. `SalesOrder.status` is a Postgres enum
// (`SalesOrderStatus`), and binding text parameters against an enum column
// needs an explicit cast -- hence `::text`. The statuses therefore travel as
// bound parameters rather than as literals spliced into the query, which keeps
// these call sites clean under the "no `${}` inside `$queryRaw`" rule.

import { Prisma } from "@prisma/client";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";

/** Aliases are developer-supplied identifiers, never user input. Validated
 *  anyway, because this is the one value that reaches `Prisma.raw`. */
const SAFE_ALIAS = /^[a-z][a-z0-9_]{0,15}$/i;

/**
 * A `SalesOrder.status` predicate limiting a raw query to revenue-bearing
 * orders, for use inside a `Prisma.sql` template:
 *
 *   WHERE ${revenueStatusSql()}
 *     AND li."lineItemStatus" <> 'CANCELLED'
 *
 * `alias` is the SalesOrder table alias in the surrounding query (`so` in
 * every current call site).
 *
 * Use this for any aggregate answering "what did this window actually generate
 * in revenue?". When a report deliberately wants a NARROWER set -- a
 * dispatch board wanting `ORDER` only, or a last-sold timestamp that should not
 * count an accounting return -- spell that filter inline with a comment saying
 * why, exactly as lib/salesOrderRevenue.ts's header prescribes. The tripwire in
 * __tests__/revenueScopeSingleSource.test.ts distinguishes the two by requiring
 * SOME status predicate, not this specific one.
 */
export function revenueStatusSql(alias = "so"): Prisma.Sql {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(`revenueStatusSql: unsafe table alias ${JSON.stringify(alias)}`);
  }
  return Prisma.sql`${Prisma.raw(`"${alias}"`)}."status"::text IN (${Prisma.join([
    ...SALES_REVENUE_STATUSES,
  ])})`;
}
