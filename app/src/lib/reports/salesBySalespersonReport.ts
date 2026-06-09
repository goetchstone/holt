// /app/src/lib/reports/salesBySalespersonReport.ts
//
// Sales-by-salesperson report: sales aggregated by salesperson, department, OR
// customer for a date range, plus a per-group line-item drilldown. Extracted
// verbatim from the Pages API (index.ts + items.ts) so the App Router page +
// tRPC procedures share one source of truth; the CSV export keeps its own REST
// route (export.ts) and calls those handlers directly during the migration.
//
// The salesperson-attribution math is load-bearing and copied as-is: the POS
// imports historically leave `salesPersonId` NULL while populating the
// `salesperson` string, so every grouping OR-matches FK + name (see
// applySalesPersonFilter / bucketBySalesperson / effectiveStaffId). Cancelled
// lines are excluded (rule 33) and RETURNED is in the status filter so negative
// return lines net out rewrite chains.
//
// Role gating is resolved through the existing resolveSalesPersonFilter helper,
// which reads a NextAuth Session. The tRPC procedure has no Session object, so
// these functions accept the role + userId as plain params and build the minimal
// Session shape the helper reads (`role`, `user.id`).

import type { PrismaClient, Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import {
  aggregateMargin,
  applySplit,
  imputeMissingCost,
  type MarginRow,
  type MarginLine,
} from "@/lib/marginMath";
import {
  type GroupBy,
  buildOrderDateFilter,
  buildLineItemWhere,
  resolveSalesPersonFilter,
  applySalesPersonFilter,
  customerLabel,
} from "@/lib/salesBySalesperson";

export type { GroupBy } from "@/lib/salesBySalesperson";

const MAX_ROWS = 500;

/**
 * Role context for the report. resolveSalesPersonFilter reads a NextAuth
 * Session (`role` at the top level, `user.id` nested); the tRPC procedure only
 * has the JWT-derived role + userId, so we accept those and reconstruct the
 * minimal shape the helper inspects.
 */
export interface SalesBySalespersonAuth {
  role: string | undefined;
  userId: string | undefined;
}

export interface SalesBySalespersonParams {
  auth: SalesBySalespersonAuth;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  groupBy?: GroupBy;
  salesPersonIds?: number[];
  departmentNames?: string[];
  includeDeliveryFreight?: boolean;
}

export interface SalesBySalespersonItemsParams extends SalesBySalespersonParams {
  groupKey: string;
}

export interface SalesByGroupRow extends MarginRow {
  groupKey: string;
  groupLabel: string;
}

export interface SalesByGroupResponse {
  groupBy: GroupBy;
  rows: SalesByGroupRow[];
  total: MarginRow;
  appliedFilters: {
    startDate: string | null;
    endDate: string | null;
    salesPersonIds: number[];
    departmentNames: string[];
    designerLockedTo: string | null;
    includeDeliveryFreight: boolean;
  };
}

export interface SalesByGroupItem {
  lineItemId: number;
  orderId: number;
  orderno: string;
  orderDate: string | null;
  customerId: number | null;
  customerLabel: string;
  partNo: string | null;
  productName: string | null;
  departmentName: string | null;
  qty: number;
  retail: number;
  cost: number;
  margin: number;
  marginPct: number;
  isSplit: boolean;
  salesPersonName: string | null;
}

interface OrderForReport {
  id: number;
  salesPersonId: number | null;
  splitWithId: number | null;
  salesperson: string | null;
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    tradeCompanyName: string | null;
  } | null;
  lineItems: {
    netPrice: Prisma.Decimal | null;
    cost: Prisma.Decimal | null;
    orderedQuantity: Prisma.Decimal | null;
    product: {
      baseCost: Prisma.Decimal | null;
      department: { name: string } | null;
    } | null;
  }[];
}

/**
 * resolveSalesPersonFilter inspects `(session as any).role` and
 * `(session.user as any).id`. Rebuild that minimal shape from plain params so
 * the helper stays untouched and the attribution rules are identical to the
 * legacy REST path.
 */
function toSession(auth: SalesBySalespersonAuth): Session {
  return {
    role: auth.role,
    user: { id: auth.userId },
  } as unknown as Session;
}

function emptyResponse(
  groupBy: GroupBy,
  startDate: string,
  endDate: string,
  includeDeliveryFreight: boolean,
): SalesByGroupResponse {
  return {
    groupBy,
    rows: [],
    total: aggregateMargin([]),
    appliedFilters: {
      startDate: startDate || null,
      endDate: endDate || null,
      salesPersonIds: [],
      departmentNames: [],
      designerLockedTo: null,
      includeDeliveryFreight,
    },
  };
}

/**
 * Bucket-write helper. Mutates `buckets` to record the line under the
 * given group key.
 */
function addToBucket(
  buckets: Map<string, { label: string; lines: MarginLine[] }>,
  key: string,
  label: string,
  line: MarginLine,
): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.lines.push(line);
  } else {
    buckets.set(key, { label, lines: [line] });
  }
}

function bucketByDepartment(
  buckets: Map<string, { label: string; lines: MarginLine[] }>,
  order: OrderForReport,
  baseLine: MarginLine,
  // The caller passes `li.product?.department?.name`, which is `string |
  // undefined` (optional chaining never produces `null`). Default
  // parameter handles the undefined case directly -- no `??` needed.
  liDepartmentName: string = "Uncategorized",
): void {
  addToBucket(buckets, `dept-${liDepartmentName}`, liDepartmentName, baseLine);
}

function bucketByCustomer(
  buckets: Map<string, { label: string; lines: MarginLine[] }>,
  order: OrderForReport,
  baseLine: MarginLine,
): void {
  const label = customerLabel(order.customer);
  const key = order.customer?.id ? `cust-${order.customer.id}` : `name-${label}`;
  addToBucket(buckets, key, label, baseLine);
}

interface StaffMaps {
  nameById: Map<number, string>;
  idByLcName: Map<string, number>;
}

/**
 * Resolve an order's effective salesPersonId. Falls back to a
 * name-match against active staff when the FK is null -- which is the
 * common case for the POS-imported orders, where `salesperson` is
 * populated but `salesPersonId` is not. Without this fallback, the
 * report severely undercounts every salesperson's totals.
 */
function effectiveStaffId(
  order: { salesPersonId: number | null; salesperson: string | null },
  idByLcName: Map<string, number>,
): number | null {
  if (order.salesPersonId !== null) return order.salesPersonId;
  if (!order.salesperson) return null;
  return idByLcName.get(order.salesperson.trim().toLowerCase()) ?? null;
}

function bucketBySalesperson(
  buckets: Map<string, { label: string; lines: MarginLine[] }>,
  order: OrderForReport,
  baseLine: MarginLine,
  maps: StaffMaps,
  lockedToStaffId: number | null,
): void {
  const isSplit = order.splitWithId !== null;
  const halfLine = applySplit(baseLine, isSplit);

  const primaryId = effectiveStaffId(order, maps.idByLcName);
  // When `lockedToStaffId` is set (designer self-only view), only emit
  // the locked designer's bucket. Without this guard, a split order's
  // PARTNER would still get a row in the result set (= the partner's
  // displayName + their half-revenue leaks). Designer should only see
  // their own half. 2026-05-05 user direction.
  const shouldEmit = (id: number | null) => lockedToStaffId === null || id === lockedToStaffId;

  if (primaryId !== null) {
    if (shouldEmit(primaryId)) {
      const name = maps.nameById.get(primaryId) || order.salesperson || "Unknown";
      addToBucket(buckets, `sp-${primaryId}`, name, halfLine);
    }
  } else if (order.salesperson) {
    // Unlinked-by-id but has a name. The lock matched via name (resolvedNames),
    // so this case ONLY runs when lockedToStaffId is null OR when the locked
    // designer's name matches. Either way safe to emit.
    if (lockedToStaffId === null) {
      addToBucket(buckets, `sp-name-${order.salesperson}`, order.salesperson, halfLine);
    }
  } else if (lockedToStaffId === null) {
    // "(no salesperson)" bucket — only show to admins, never to a locked designer
    addToBucket(buckets, "sp-unassigned", "(no salesperson)", halfLine);
  }
  if (isSplit && order.splitWithId !== null && shouldEmit(order.splitWithId)) {
    const name2 = maps.nameById.get(order.splitWithId) || "Unknown";
    addToBucket(buckets, `sp-${order.splitWithId}`, name2, halfLine);
  }
}

/**
 * Three-step cost fallback (user direction 2026-04-30):
 *   1. li.cost if set and non-zero
 *   2. product.baseCost × qty if li.cost is zero AND baseCost is set
 *   3. retail/2 imputation handled by imputeMissingCost downstream
 */
function resolveLineCost(li: OrderForReport["lineItems"][number]): number {
  const rawLineCost = Number(li.cost ?? 0);
  if (rawLineCost !== 0) return rawLineCost;
  const qty = Number(li.orderedQuantity ?? 1);
  const productBaseCost = Number(li.product?.baseCost ?? 0);
  if (productBaseCost > 0 && qty > 0) return productBaseCost * qty;
  return 0;
}

/**
 * Dispatches a single line to the right bucket based on the active
 * groupBy. Extracted so its switch logic doesn't count toward cog
 * complexity (S3776).
 */
function routeLineToBucket(
  buckets: Map<string, { label: string; lines: MarginLine[] }>,
  order: OrderForReport,
  baseLine: MarginLine,
  liDepartmentName: string | undefined,
  groupBy: GroupBy,
  staffMaps: StaffMaps,
  lockedToStaffId: number | null,
): void {
  if (groupBy === "department") {
    bucketByDepartment(buckets, order, baseLine, liDepartmentName);
  } else if (groupBy === "customer") {
    bucketByCustomer(buckets, order, baseLine);
  } else {
    bucketBySalesperson(buckets, order, baseLine, staffMaps, lockedToStaffId);
  }
}

/**
 * Load both directions of the staff name lookup. `nameById` powers the
 * row label; `idByLcName` (lowercased) lets us route an unlinked order
 * (FK NULL but `salesperson` populated) into the same bucket as the
 * matching staff member.
 */
async function loadStaffMaps(prisma: PrismaClient, orders: OrderForReport[]): Promise<StaffMaps> {
  const fkIds = new Set<number>();
  const unlinkedNames = new Set<string>();
  for (const o of orders) {
    if (o.salesPersonId) fkIds.add(o.salesPersonId);
    if (o.splitWithId) fkIds.add(o.splitWithId);
    if (!o.salesPersonId && o.salesperson) unlinkedNames.add(o.salesperson.trim());
  }
  const nameById = new Map<number, string>();
  const idByLcName = new Map<string, number>();
  if (fkIds.size === 0 && unlinkedNames.size === 0) return { nameById, idByLcName };

  const orClauses: Prisma.StaffMemberWhereInput[] = [];
  if (fkIds.size > 0) orClauses.push({ id: { in: Array.from(fkIds) } });
  for (const n of unlinkedNames) {
    orClauses.push({ displayName: { equals: n, mode: "insensitive" } });
  }
  const staff = await prisma.staffMember.findMany({
    where: orClauses.length === 1 ? orClauses[0] : { OR: orClauses },
    select: { id: true, displayName: true },
  });
  for (const s of staff) {
    nameById.set(s.id, s.displayName);
    idByLcName.set(s.displayName.toLowerCase(), s.id);
  }
  return { nameById, idByLcName };
}

export async function getSalesBySalesperson(
  prisma: PrismaClient,
  params: SalesBySalespersonParams,
): Promise<SalesByGroupResponse> {
  const startDate = params.startDate ?? "";
  const endDate = params.endDate ?? "";
  const groupBy: GroupBy = params.groupBy ?? "salesperson";
  const requestedSalesPersonIds = params.salesPersonIds ?? [];
  const departmentNames = params.departmentNames ?? [];
  const includeDeliveryFreight = params.includeDeliveryFreight ?? false;

  const filter = await resolveSalesPersonFilter(toSession(params.auth), requestedSalesPersonIds);
  if (filter === null) {
    // Authenticated but no staff record -- return empty rather than throwing.
    return emptyResponse(groupBy, startDate, endDate, includeDeliveryFreight);
  }

  const orderWhere: Prisma.SalesOrderWhereInput = {
    status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
  };
  const dateFilter = buildOrderDateFilter(startDate, endDate);
  if (dateFilter) orderWhere.orderDate = dateFilter;
  applySalesPersonFilter(orderWhere, {
    ids: filter.resolvedIds,
    names: filter.resolvedNames,
  });

  const orders = await prisma.salesOrder.findMany({
    where: orderWhere,
    select: {
      id: true,
      salesPersonId: true,
      splitWithId: true,
      salesperson: true,
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          tradeCompanyName: true,
        },
      },
      lineItems: {
        where: buildLineItemWhere(departmentNames, includeDeliveryFreight),
        select: {
          netPrice: true,
          cost: true,
          orderedQuantity: true,
          product: {
            select: {
              baseCost: true,
              department: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const staffMaps = await loadStaffMaps(prisma, orders);
  const buckets = new Map<string, { label: string; lines: MarginLine[] }>();

  // When the caller is a non-privileged designer, lock buckets to
  // their own staff id so split-order partners' names + revenue
  // never appear in the rows. resolvedIds.length === 1 in that case
  // (resolveSalesPersonFilter sets ids = [callerStaff.id]).
  const lockedToStaffId =
    !filter.isPrivileged && filter.resolvedIds.length === 1 ? filter.resolvedIds[0] : null;

  for (const order of orders) {
    for (const li of order.lineItems) {
      const baseLine: MarginLine = imputeMissingCost({
        retail: Number(li.netPrice ?? 0),
        cost: resolveLineCost(li),
      });
      routeLineToBucket(
        buckets,
        order,
        baseLine,
        li.product?.department?.name,
        groupBy,
        staffMaps,
        lockedToStaffId,
      );
    }
  }

  const rows: SalesByGroupRow[] = Array.from(buckets.entries())
    .map(([groupKey, { label, lines }]) => ({
      groupKey,
      groupLabel: label,
      ...aggregateMargin(lines),
    }))
    .sort((a, b) => b.retail - a.retail);

  const total = aggregateMargin(rows.map((r) => ({ retail: r.retail, cost: r.cost })));

  return {
    groupBy,
    rows,
    total,
    appliedFilters: {
      startDate: startDate || null,
      endDate: endDate || null,
      salesPersonIds: filter.resolvedIds,
      departmentNames,
      designerLockedTo: filter.designerLockedTo,
      includeDeliveryFreight,
    },
  };
}

// ----------------------------------------------------------------------------
// Drilldown (formerly items.ts)
// ----------------------------------------------------------------------------

interface NarrowedKey {
  groupSalesPersonId: number | null;
  groupCustomerId: number | null;
  groupCustomerName: string | null;
  groupDepartmentName: string | null;
  reject: boolean;
}

/**
 * Narrow the order-where (and report which line-item filter to layer
 * on) based on the group key. Returns reject=true if the key is
 * malformed and the caller should respond with empty data.
 */
function narrowByGroupKey(
  groupBy: GroupBy,
  groupKey: string,
  orderWhere: Prisma.SalesOrderWhereInput,
  designerStaffId: number | null,
  staffNameForId: string | null,
): NarrowedKey {
  const result: NarrowedKey = {
    groupSalesPersonId: null,
    groupCustomerId: null,
    groupCustomerName: null,
    groupDepartmentName: null,
    reject: false,
  };

  if (groupBy === "salesperson") {
    return narrowSalesperson(groupKey, orderWhere, designerStaffId, staffNameForId, result);
  }
  if (groupBy === "customer") {
    return narrowCustomer(groupKey, orderWhere, result);
  }
  if (groupBy === "department" && groupKey.startsWith("dept-")) {
    result.groupDepartmentName = groupKey.slice("dept-".length);
  }
  return result;
}

function narrowSalesperson(
  groupKey: string,
  orderWhere: Prisma.SalesOrderWhereInput,
  designerStaffId: number | null,
  staffNameForId: string | null,
  result: NarrowedKey,
): NarrowedKey {
  if (groupKey.startsWith("sp-name-")) {
    // Truly unlinked orders -- no FK match was found in the bucketing
    // step, so this drilldown should ONLY include orders where the FK
    // is null and the name string matches exactly.
    const name = groupKey.slice("sp-name-".length);
    orderWhere.salesPersonId = null;
    orderWhere.salesperson = { equals: name, mode: "insensitive" };
    return result;
  }
  if (groupKey === "sp-unassigned") {
    orderWhere.salesPersonId = null;
    orderWhere.salesperson = null;
    return result;
  }
  if (groupKey.startsWith("sp-")) {
    const id = Number.parseInt(groupKey.slice("sp-".length), 10);
    if (!Number.isFinite(id)) {
      result.reject = true;
      return result;
    }
    // Designer can't see other salespeople's drilldowns even if they
    // somehow guess the groupKey. The orderWhere.OR set by
    // applySalesPersonFilter already restricts to their own; this
    // additional check is defense-in-depth.
    if (designerStaffId !== null && id !== designerStaffId) {
      result.reject = true;
      return result;
    }
    result.groupSalesPersonId = id;
    // Match by FK *and* by name string (the POS imports leave the FK
    // null on most orders -- without the name fallback the drilldown
    // misses ~98% of rows). The caller pre-fetched the staff's
    // displayName for this id so we can OR it in here.
    const orClauses: Prisma.SalesOrderWhereInput[] = [{ salesPersonId: id }, { splitWithId: id }];
    if (staffNameForId) {
      orClauses.push({
        AND: [
          { salesPersonId: null },
          { salesperson: { equals: staffNameForId, mode: "insensitive" } },
        ],
      });
    }
    orderWhere.OR = orClauses;
  }
  return result;
}

function narrowCustomer(
  groupKey: string,
  orderWhere: Prisma.SalesOrderWhereInput,
  result: NarrowedKey,
): NarrowedKey {
  if (groupKey.startsWith("cust-")) {
    const id = Number.parseInt(groupKey.slice("cust-".length), 10);
    if (!Number.isFinite(id)) {
      result.reject = true;
      return result;
    }
    result.groupCustomerId = id;
    orderWhere.customerId = id;
    return result;
  }
  if (groupKey.startsWith("name-")) {
    // Customer with no FK -- match by computed name post-fetch
    result.groupCustomerName = groupKey.slice("name-".length);
  }
  return result;
}

interface RawOrder {
  id: number;
  orderno: string;
  orderDate: Date | null;
  salesPersonId: number | null;
  splitWithId: number | null;
  salesperson: string | null;
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    tradeCompanyName: string | null;
  } | null;
  lineItems: {
    id: number;
    partNo: string | null;
    productName: string | null;
    netPrice: Prisma.Decimal | null;
    cost: Prisma.Decimal | null;
    orderedQuantity: Prisma.Decimal | null;
    product: {
      baseCost: Prisma.Decimal | null;
      department: { name: string } | null;
    } | null;
  }[];
}

function shouldSkipOrder(order: RawOrder, narrowed: NarrowedKey, groupBy: GroupBy): boolean {
  // Customer-by-name post-filter: if the user clicked a name- key
  // (no customer FK), only include orders whose computed name matches
  // AND who genuinely have no customer id.
  if (
    groupBy === "customer" &&
    narrowed.groupCustomerName !== null &&
    narrowed.groupCustomerId === null
  ) {
    if (customerLabel(order.customer) !== narrowed.groupCustomerName) return true;
    if (order.customer?.id) return true;
  }
  return false;
}

function resolveSalesPersonName(
  order: RawOrder,
  narrowed: NarrowedKey,
  groupBy: GroupBy,
  staffNameById: Map<number, string>,
): string | null {
  if (groupBy === "salesperson" && narrowed.groupSalesPersonId !== null) {
    return staffNameById.get(narrowed.groupSalesPersonId) || null;
  }
  if (order.salesPersonId) {
    return staffNameById.get(order.salesPersonId) || order.salesperson || null;
  }
  return order.salesperson || null;
}

function lineToItem(
  order: RawOrder,
  li: RawOrder["lineItems"][number],
  groupBy: GroupBy,
  salesPersonName: string | null,
  custLabel: string,
): SalesByGroupItem {
  const isSplit = order.splitWithId !== null;
  // Cost fallback chain (user direction 2026-04-30):
  //   1. line cost (`li.cost`) if it's set and non-zero
  //   2. product baseCost × ordered quantity if li.cost is zero/missing
  //      but the product card has a baseCost
  //   3. `retail / 2` interim imputation (last-resort 50% margin) via
  //      `imputeMissingCost`
  // Without step 2, every line whose the POS cost was missing showed
  // 50% margin even when the product had a real baseCost.
  const rawLineCost = Number(li.cost ?? 0);
  const qty = Number(li.orderedQuantity ?? 1);
  const productBaseCost = Number(li.product?.baseCost ?? 0);
  let resolvedCost = rawLineCost;
  if (resolvedCost === 0 && productBaseCost > 0 && qty > 0) {
    resolvedCost = productBaseCost * qty;
  }
  const cleaned = imputeMissingCost({
    retail: Number(li.netPrice ?? 0),
    cost: resolvedCost,
  });
  const showSplit = groupBy === "salesperson" && isSplit;
  const halved = applySplit(cleaned, showSplit);
  const margin = halved.retail - halved.cost;
  const marginPct = halved.retail === 0 ? 0 : margin / halved.retail;

  return {
    lineItemId: li.id,
    orderId: order.id,
    orderno: order.orderno,
    orderDate: order.orderDate ? order.orderDate.toISOString() : null,
    customerId: order.customer?.id ?? null,
    customerLabel: custLabel,
    partNo: li.partNo,
    productName: li.productName,
    departmentName: li.product?.department?.name ?? null,
    qty,
    retail: Math.round(halved.retail * 100) / 100,
    cost: Math.round(halved.cost * 100) / 100,
    margin: Math.round(margin * 100) / 100,
    marginPct,
    isSplit,
    salesPersonName,
  };
}

/**
 * Pre-fetch the staff displayName for an `sp-${id}` drilldown group key.
 * Used by `narrowSalesperson` so the drilldown can OR in a name-match
 * clause for unlinked orders. Returns null for non-id group keys
 * (sp-name-* or sp-unassigned) -- those don't need a name lookup.
 */
async function resolveStaffNameForGroupKey(
  prisma: PrismaClient,
  groupBy: GroupBy,
  groupKey: string,
): Promise<string | null> {
  if (groupBy !== "salesperson") return null;
  if (!groupKey.startsWith("sp-")) return null;
  if (groupKey.startsWith("sp-name-") || groupKey === "sp-unassigned") return null;
  const id = Number.parseInt(groupKey.slice("sp-".length), 10);
  if (!Number.isFinite(id)) return null;
  const staff = await prisma.staffMember.findUnique({
    where: { id },
    select: { displayName: true },
  });
  return staff?.displayName ?? null;
}

/**
 * Materialize the line-item-level result rows from raw orders, capped
 * at MAX_ROWS. Extracted to keep cog complexity in check (S3776). The
 * double-break pattern is the cap enforcement; shouldSkipOrder filters
 * customer-by-name post-fetch.
 */
function buildResultRows(
  orders: RawOrder[],
  narrowed: NarrowedKey,
  groupBy: GroupBy,
  staffNameById: Map<number, string>,
): SalesByGroupItem[] {
  const rows: SalesByGroupItem[] = [];
  for (const order of orders) {
    if (shouldSkipOrder(order, narrowed, groupBy)) continue;
    const custLabel = customerLabel(order.customer);
    const salesPersonName = resolveSalesPersonName(order, narrowed, groupBy, staffNameById);
    for (const li of order.lineItems) {
      rows.push(lineToItem(order, li, groupBy, salesPersonName, custLabel));
      if (rows.length >= MAX_ROWS) return rows;
    }
  }
  return rows;
}

async function loadStaffNameMap(
  prisma: PrismaClient,
  partnerIds: Iterable<number>,
): Promise<Map<number, string>> {
  const ids = Array.from(new Set(partnerIds));
  if (ids.length === 0) return new Map();
  const staff = await prisma.staffMember.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  const map = new Map<number, string>();
  for (const s of staff) map.set(s.id, s.displayName);
  return map;
}

/**
 * Build the initial SalesOrder where clause for the drilldown query
 * before group-key narrowing is layered on top. Extracted so the entry
 * point doesn't have to inline the date-filter conditional + the
 * applySalesPersonFilter call (S3776).
 */
function buildBaseOrderWhere(
  filter: { resolvedIds: number[]; resolvedNames: string[] },
  startDate: string,
  endDate: string,
): Prisma.SalesOrderWhereInput {
  const orderWhere: Prisma.SalesOrderWhereInput = {
    status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
  };
  const dateFilter = buildOrderDateFilter(startDate, endDate);
  if (dateFilter) orderWhere.orderDate = dateFilter;
  applySalesPersonFilter(orderWhere, {
    ids: filter.resolvedIds,
    names: filter.resolvedNames,
  });
  return orderWhere;
}

/**
 * Collect the set of staff ids whose displayNames we need to populate
 * the salesPersonName column on each drilldown row. Includes the FK
 * id, the splitWith id, and the group-key id (so an FK-null group-by-
 * salesperson drilldown still labels its rows).
 */
function collectPartnerIds(orders: RawOrder[], narrowed: NarrowedKey): Set<number> {
  const partnerIds = new Set<number>();
  for (const o of orders) {
    if (o.salesPersonId) partnerIds.add(o.salesPersonId);
    if (o.splitWithId) partnerIds.add(o.splitWithId);
  }
  if (narrowed.groupSalesPersonId !== null) {
    partnerIds.add(narrowed.groupSalesPersonId);
  }
  return partnerIds;
}

export async function getSalesBySalespersonItems(
  prisma: PrismaClient,
  params: SalesBySalespersonItemsParams,
): Promise<SalesByGroupItem[]> {
  const startDate = params.startDate ?? "";
  const endDate = params.endDate ?? "";
  const groupBy: GroupBy = params.groupBy ?? "salesperson";
  const requestedSalesPersonIds = params.salesPersonIds ?? [];
  const departmentNames = params.departmentNames ?? [];
  const includeDeliveryFreight = params.includeDeliveryFreight ?? false;
  const groupKey = params.groupKey;
  if (!groupKey) return [];

  const filter = await resolveSalesPersonFilter(toSession(params.auth), requestedSalesPersonIds);
  if (filter === null) return [];

  const orderWhere = buildBaseOrderWhere(filter, startDate, endDate);

  const designerStaffId =
    filter.designerLockedTo !== null && filter.resolvedIds.length === 1
      ? filter.resolvedIds[0]
      : null;

  const staffNameForId = await resolveStaffNameForGroupKey(prisma, groupBy, groupKey);

  const narrowed = narrowByGroupKey(groupBy, groupKey, orderWhere, designerStaffId, staffNameForId);
  if (narrowed.reject) return [];

  // Effective department filter: if grouping by department, the
  // group key narrows to that single department; user-selected
  // multi-dept filter is ignored (the user is drilling INTO that one).
  const effectiveDeptFilter =
    groupBy === "department" && narrowed.groupDepartmentName
      ? [narrowed.groupDepartmentName]
      : departmentNames;

  const orders = (await prisma.salesOrder.findMany({
    where: orderWhere,
    orderBy: [{ orderDate: "desc" }, { id: "desc" }],
    select: {
      id: true,
      orderno: true,
      orderDate: true,
      salesPersonId: true,
      splitWithId: true,
      salesperson: true,
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          tradeCompanyName: true,
        },
      },
      lineItems: {
        where: buildLineItemWhere(effectiveDeptFilter, includeDeliveryFreight),
        select: {
          id: true,
          partNo: true,
          productName: true,
          netPrice: true,
          cost: true,
          orderedQuantity: true,
          product: {
            select: {
              baseCost: true,
              department: { select: { name: true } },
            },
          },
        },
      },
    },
  })) as RawOrder[];

  const partnerIds = collectPartnerIds(orders, narrowed);
  const staffNameById = await loadStaffNameMap(prisma, partnerIds);
  return buildResultRows(orders, narrowed, groupBy, staffNameById);
}
