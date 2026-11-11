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
import { COUNTED_LINE_STATUSES, SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";

/** Aliases are developer-supplied identifiers, never user input. Validated
 *  anyway, because this is the one value that reaches `Prisma.raw`. */
const SAFE_ALIAS = /^[a-z][a-z0-9_]{0,15}$/i;

function safeAlias(alias: string, caller: string): string {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(`${caller}: unsafe table alias ${JSON.stringify(alias)}`);
  }
  return alias;
}

/**
 * A `SalesOrder.status` predicate limiting a raw query to revenue-bearing
 * orders, for use inside a `Prisma.sql` template:
 *
 *   WHERE ${revenueStatusSql()}
 *     AND ${countedLineSql()}
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
  return Prisma.sql`${Prisma.raw(`"${safeAlias(alias, "revenueStatusSql")}"`)}."status"::text IN (${Prisma.join(
    [...SALES_REVENUE_STATUSES],
  )})`;
}

/**
 * An `OrderLineItem.lineItemStatus` predicate for every sum and count over lines (rule 33):
 * COUNTED_LINE_STATUSES, so cancelled and replaced lines are out. Leaving out only CANCELLED
 * counts a replaced line and its replacement both. For a `Prisma.sql` template; `alias` is
 * the line table's alias in the surrounding query.
 */
export function countedLineSql(alias = "li"): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(`"${safeAlias(alias, "countedLineSql")}"`)}."lineItemStatus"::text IN (${Prisma.join(
    [...COUNTED_LINE_STATUSES],
  )})`;
}

/**
 * The same predicate spelled out, for a query built as a string ($queryRawUnsafe). The
 * statuses are the constant's own, never input.
 */
export function countedLineSqlText(alias = "li"): string {
  const statuses = COUNTED_LINE_STATUSES.map((status) => `'${status}'`).join(", ");
  return `"${safeAlias(alias, "countedLineSqlText")}"."lineItemStatus"::text IN (${statuses})`;
}

// countedLineSql keeps a gift card line in, so it is for what a customer owes. Revenue,
// reports and goods leave a card line out with the two below (COUNTED_ITEM_LINE in
// lib/salesOrderRevenue.ts says why).

/**
 * countedLineSql AND not a gift card line: the counted lines that are items. Parenthesised,
 * so it reads as one predicate wherever it is dropped. `IS NULL` is a positive match, so no
 * row slips past it (rule 51).
 */
export function countedItemLineSql(alias = "li"): Prisma.Sql {
  const table = Prisma.raw(`"${safeAlias(alias, "countedItemLineSql")}"`);
  return Prisma.sql`(${table}."lineItemStatus"::text IN (${Prisma.join([
    ...COUNTED_LINE_STATUSES,
  ])}) AND ${table}."giftCardNumber" IS NULL)`;
}

/** countedItemLineSql spelled out, for a query built as a string ($queryRawUnsafe). */
export function countedItemLineSqlText(alias = "li"): string {
  const table = `"${safeAlias(alias, "countedItemLineSqlText")}"`;
  const statuses = COUNTED_LINE_STATUSES.map((status) => `'${status}'`).join(", ");
  return `(${table}."lineItemStatus"::text IN (${statuses}) AND ${table}."giftCardNumber" IS NULL)`;
}
