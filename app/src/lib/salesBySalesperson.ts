// /app/src/lib/salesBySalesperson.ts
//
// Shared logic for the sales-by-salesperson report endpoints. Extracted
// from the API handlers (index.ts, items.ts, export.ts) so each handler
// stays under cognitive complexity threshold and the role-gate /
// parsing rules live in ONE place. Lives in lib/ rather than under
// pages/api/ because Next.js Pages Router exposes every .ts file in
// pages/api/ as a route -- there's no underscore-prefix convention to
// hide it.

import type { NextApiRequest } from "next";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Canonical productNames the POS uses for delivery / freight pass-through
 * lines. Verified against the 2026-05-01 prod backup — these five exact
 * strings (case-insensitive) cover every line the POS excludes from its
 * own salesperson reports. Matching this list keeps our totals in parity
 * with the POS's "Salesperson Monthly Sales Table."
 *
 * History: prior versions used `partNo contains 'delivery|freight'` plus
 * `productName contains 'delivery|freight'`. The contains-on-productName
 * arm matched real product lines whose freeform productName text
 * happened to mention delivery (e.g. SO-38708, $7,176 of Susan Roberts'
 * April sales had productName "Delivery to 8 Monticello Dr East Lyme"
 * because the import wrote `row.ordernotes` into productName
 * when "Product Name" was empty -- see post-failure log 2026-05-01).
 * That false-positive class is closed by switching to exact match.
 *
 * Labor charges are NOT in this list -- designers get credit for labor.
 */
const DELIVERY_FREIGHT_PRODUCT_NAMES = [
  "Delivery Charge",
  "Freight",
  "HD Freight",
  "Freight - Hunter Douglas",
  "Hunter Douglas Freight",
] as const;

const DELIVERY_FREIGHT_MATCH_CLAUSES: Prisma.OrderLineItemWhereInput[] =
  DELIVERY_FREIGHT_PRODUCT_NAMES.map((name) => ({
    productName: { equals: name, mode: "insensitive" },
  }));

// SUPER_ADMIN strictly more privileged than ADMIN — included in every
// privileged-role set so the owner sees the same data ADMIN would.
const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "MANAGER", "MARKETING"]);

export type GroupBy = "salesperson" | "department" | "customer";

export function parseGroupBy(raw: unknown): GroupBy {
  if (raw === "department") return "department";
  if (raw === "customer") return "customer";
  return "salesperson";
}

export function parseIdList(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function parseStringList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildOrderDateFilter(
  startDate: string,
  endDate: string,
): Prisma.SalesOrderWhereInput["orderDate"] | undefined {
  if (!startDate && !endDate) return undefined;
  const filter: { gte?: Date; lte?: Date } = {};
  if (startDate) filter.gte = new Date(`${startDate}T00:00:00.000Z`);
  if (endDate) filter.lte = new Date(`${endDate}T23:59:59.999Z`);
  return filter;
}

/**
 * Build the line-item where clause for a salesperson-aware query.
 *
 * Default behavior is to exclude delivery + freight pass-through lines
 * (matched case-insensitively against productName against the canonical
 * 5-name list above). Labor is NOT excluded -- designers get credit for
 * labor on the salesperson reports. Set `includeDeliveryFreight = true`
 * to add them back in.
 *
 * The cancelled-line filter (CLAUDE.md rule 33) is unconditional.
 *
 * NULL-safety on productName (failure-log 2026-05-05):
 * ----------------------------------------------------
 * `productName` is nullable in the schema. Postgres three-valued logic
 * excludes rows where the comparison is UNKNOWN (NULL = anything →
 * UNKNOWN, OR/AND/NOT propagate UNKNOWN, the WHERE clause drops
 * UNKNOWN rows). The previous implementation was
 * `where.NOT = { OR: [productName equals 'A', equals 'B', ...] }`,
 * which silently dropped EVERY line whose productName was NULL —
 * 172 ACTIVE rows totalling $91,151 across the production DB. Julia
 * Filippone's SO-1660 line 2 (Mike Recliner, $3,695, productName=NULL)
 * was the user-reported instance.
 *
 * The fix below explicitly OR-clauses `productName: null` so NULL rows
 * pass through, then AND-clauses the per-name `not equals` checks for
 * non-NULL rows. Same shape as the well-known `Payment.status NULL`
 * gotcha in CLAUDE.md.
 *
 * Note on lineItemStatus: schema declares it non-nullable
 * (`@default(ACTIVE)`) so the NULL trap doesn't apply at the type
 * level. ~67K legacy rows still hold NULL from a pre-field migration;
 * those are backfilled to ACTIVE in the
 * `20260505_backfill_lineitem_status_nulls` migration shipped with this
 * change so the schema and data agree.
 */
export function buildLineItemWhere(
  departmentNames: string[],
  includeDeliveryFreight = false,
): Prisma.OrderLineItemWhereInput {
  const where: Prisma.OrderLineItemWhereInput = {
    lineItemStatus: { not: "CANCELLED" },
  };
  if (!includeDeliveryFreight) {
    // NULL productNames are NOT delivery/freight — admit them via the
    // OR-with-null arm. Prisma rejects `not: { equals, mode }` for
    // nullable string fields ("Unknown argument `mode`" — caught in
    // prod 2026-05-05), so we keep the inner exclusion in the original
    // `NOT { OR: equals }` form (case-insensitive) and rely on the
    // outer OR to short-circuit NULL rows past the three-valued-logic
    // trap before the NOT-OR ever evaluates them.
    where.AND = [
      {
        OR: [{ productName: null }, { NOT: { OR: DELIVERY_FREIGHT_MATCH_CLAUSES } }],
      },
    ];
  }
  if (departmentNames.length > 0) {
    where.product = { department: { name: { in: departmentNames } } };
  }
  return where;
}

/**
 * Resolve the role-gated salesperson filter. Returns:
 *   - resolvedIds: staffIds the caller is allowed to filter against
 *   - resolvedNames: matching displayNames for those staffIds, used to
 *     match unlinked orders (the POS imports historically left
 *     `salesPersonId` NULL even when `salesperson` is set; ~98% of
 *     April 2026 orders are like this -- see `applySalesPersonFilter`).
 *   - designerLockedTo: the auto-locked displayName when the caller is
 *     a designer being forced to self-only.
 *
 * Returns null if the caller is a non-privileged user with no matching
 * staff record -- caller should respond with empty data.
 */
export async function resolveSalesPersonFilter(
  session: Session,
  requestedIds: number[],
): Promise<{
  resolvedIds: number[];
  resolvedNames: string[];
  designerLockedTo: string | null;
  isPrivileged: boolean;
} | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = (session as any)?.role as string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (session.user as any)?.id as string | undefined;
  const isPrivileged = role !== undefined && PRIVILEGED_ROLES.has(role);

  if (isPrivileged) {
    // Look up displayNames + aliases for the requested staffIds so the
    // report can match by name on unlinked orders. If none requested,
    // both arrays stay empty -- which means "no salesperson filter
    // applied" (e.g. admin viewing all-up).
    // Aliases (Issue #274 / ROADMAP Short-Term #12) ensure designers
    // whose the POS salesperson string differs from their displayName
    // (e.g. Sandy ↔ Sandra Matheny) still find their orders.
    let resolvedNames: string[] = [];
    if (requestedIds.length > 0) {
      const staff = await prisma.staffMember.findMany({
        where: { id: { in: requestedIds } },
        select: { displayName: true, aliases: true },
      });
      resolvedNames = staff.flatMap((s) => [s.displayName, ...(s.aliases ?? [])]);
    }
    return {
      resolvedIds: requestedIds,
      resolvedNames,
      designerLockedTo: null,
      isPrivileged: true,
    };
  }

  // Non-privileged: lock to caller's own staffId (incl. their aliases).
  const callerStaff = userId
    ? await prisma.staffMember.findFirst({
        where: { userId },
        select: { id: true, displayName: true, aliases: true },
      })
    : null;
  if (!callerStaff) return null;
  return {
    resolvedIds: [callerStaff.id],
    resolvedNames: [callerStaff.displayName, ...(callerStaff.aliases ?? [])],
    designerLockedTo: callerStaff.displayName,
    isPrivileged: false,
  };
}

/**
 * Apply the salesperson where-clause to an existing order-where input.
 *
 * This is where the bug lived through 2026-04-29: the filter only
 * matched on the `salesPersonId` / `splitWithId` foreign keys, but
 * sales imports historically only populate the `salesperson` STRING.
 * 98% of recent orders had a name but no FK, so the report grossly
 * undercounted everyone. Monthly Performance + Designer Dashboard
 * already match by name; this brings Sales by Salesperson into line.
 *
 * If neither ids nor names are present, the filter is a no-op (caller
 * is admin-viewing-all).
 */
/**
 * Build the {ids, names} filter input from a StaffMember row, expanding
 * `aliases` into the names array. Used together with applySalesPersonFilter
 * below to OR-match across (FK + displayName + every alias).
 *
 * Origin: Issue #274 / ROADMAP Short-Term #12. Sandy's dashboard query
 * filtered on `displayName='Sandy'` but every imported SalesOrder had
 * `salesperson='Sandra Matheny'`. Aliases (`['Sandra Matheny']` on her
 * StaffMember row) close the gap without renaming the up-board record.
 *
 * `null` staff is acceptable — returns an empty filter (no-op when fed
 * to applySalesPersonFilter).
 */
export function staffMemberFilter(
  staff: { id: number; displayName: string; aliases?: string[] } | null | undefined,
): { ids: number[]; names: string[] } {
  if (!staff) return { ids: [], names: [] };
  const names = [staff.displayName, ...(staff.aliases ?? [])];
  return { ids: [staff.id], names };
}

export function applySalesPersonFilter(
  orderWhere: Prisma.SalesOrderWhereInput,
  filter: { ids: number[]; names: string[] },
): void {
  if (filter.ids.length === 0 && filter.names.length === 0) return;
  const orClauses: Prisma.SalesOrderWhereInput[] = [];
  if (filter.ids.length > 0) {
    orClauses.push({ salesPersonId: { in: filter.ids } }, { splitWithId: { in: filter.ids } });
  }
  // Prisma's `in` is case-sensitive on strings; use one `equals` clause
  // per name with mode=insensitive so a name matches regardless of the
  // case the source system happened to export.
  for (const name of filter.names) {
    orClauses.push({ salesperson: { equals: name, mode: "insensitive" } });
  }
  orderWhere.OR = orClauses;
}

/**
 * Standard customer-label resolution. Mirrors the convention used in
 * the existing salesperson-detail report.
 */
export function customerLabel(
  customer: {
    firstName: string | null;
    lastName: string | null;
    tradeCompanyName: string | null;
  } | null,
): string {
  if (!customer) return "Unknown";
  const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  return fullName || customer.tradeCompanyName || "Unknown";
}

/**
 * Parse the standard query params from a request. Centralizes the
 * parsing logic so both index.ts and items.ts can share it.
 *
 * `includeDeliveryFreight` parses to true only on the literal strings
 * "1" or "true" (case-insensitive). Anything else, including absent,
 * is false (default: exclude delivery + freight).
 */
export function parseStandardQuery(req: NextApiRequest): {
  startDate: string;
  endDate: string;
  groupBy: GroupBy;
  requestedSalesPersonIds: number[];
  departmentNames: string[];
  includeDeliveryFreight: boolean;
} {
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : "";
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : "";
  const raw =
    typeof req.query.includeDeliveryFreight === "string"
      ? req.query.includeDeliveryFreight.toLowerCase()
      : "";
  return {
    startDate,
    endDate,
    groupBy: parseGroupBy(req.query.groupBy),
    requestedSalesPersonIds: parseIdList(req.query.salesPersonIds),
    departmentNames: parseStringList(req.query.departmentNames),
    includeDeliveryFreight: raw === "1" || raw === "true",
  };
}
