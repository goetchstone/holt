// /app/src/lib/customers/emailList.ts
//
// GAP-08: a customer email list, filtered. Until now the only way out was the
// admin's full Customers table export (admin/export/customers), every column
// of every customer. A marketing list wants the people who match: bought in a
// date range, at a store, at a level, trade or retail, by how they heard of the
// store -- and only those with an email.
//
// "Bought" counts what revenue counts (rule 47): an order whose status is in
// SALES_REVENUE_STATUSES. The days are the store's business days
// (businessDayRange), so "bought on the 1st" means the 1st on the store's clock.
//
// Opt-outs are not tracked here: Holt sends no campaign mail itself. The screen
// says so -- send the list through a tool that honours unsubscribes.

import type { Prisma, PrismaClient } from "@prisma/client";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import { businessDayRange, isDayKey } from "@/lib/reports/businessDay";
import { csvRow } from "@/lib/csvExport";

type Db = PrismaClient | Prisma.TransactionClient;

export class EmailListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailListError";
  }
}

export interface EmailListFilter {
  /** Bought on or after this business day, "YYYY-MM-DD". */
  boughtFrom?: string;
  /** Bought on or before this business day, "YYYY-MM-DD". */
  boughtTo?: string;
  /** Bought at this store. */
  storeLocationId?: number;
  /** Customer level at least this (Customer.customerLevel). */
  minLevel?: number;
  trade?: "trade" | "retail";
  referralSourceId?: number;
}

function queryText(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function queryWhole(query: Record<string, unknown>, key: string): number | undefined {
  const v = queryText(query, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new EmailListError(`${key} must be a whole number.`);
  return n;
}

function queryDay(query: Record<string, unknown>, key: string): string | undefined {
  const v = queryText(query, key);
  if (v !== undefined && !isDayKey(v)) {
    throw new EmailListError(`${key} must be a date (YYYY-MM-DD).`);
  }
  return v;
}

function queryTrade(query: Record<string, unknown>): "trade" | "retail" | undefined {
  const v = queryText(query, "trade");
  if (v !== undefined && v !== "trade" && v !== "retail") {
    throw new EmailListError('trade must be "trade" or "retail".');
  }
  return v;
}

/** A filter from query-string values, checked; throws EmailListError on a bad one. */
export function readEmailListFilter(query: Record<string, unknown>): EmailListFilter {
  const filter: EmailListFilter = {
    boughtFrom: queryDay(query, "boughtFrom"),
    boughtTo: queryDay(query, "boughtTo"),
    storeLocationId: queryWhole(query, "storeLocationId"),
    minLevel: queryWhole(query, "minLevel"),
    trade: queryTrade(query),
    referralSourceId: queryWhole(query, "referralSourceId"),
  };
  if (filter.boughtFrom && filter.boughtTo && filter.boughtFrom > filter.boughtTo) {
    throw new EmailListError("The first day comes after the last.");
  }
  for (const key of Object.keys(filter) as (keyof EmailListFilter)[]) {
    if (filter[key] === undefined) delete filter[key];
  }
  return filter;
}

/** The sales a "bought" filter asks for: revenue orders, in the days, at the store. */
async function boughtWhere(
  db: Db,
  filter: EmailListFilter,
  timeZone: string,
): Promise<Prisma.SalesOrderWhereInput> {
  const order: Prisma.SalesOrderWhereInput = { status: { in: [...SALES_REVENUE_STATUSES] } };
  if (filter.boughtFrom || filter.boughtTo) {
    order.orderDate = {
      ...(filter.boughtFrom ? { gte: businessDayRange(filter.boughtFrom, timeZone).gte } : {}),
      ...(filter.boughtTo ? { lt: businessDayRange(filter.boughtTo, timeZone).lt } : {}),
    };
  }
  if (filter.storeLocationId) {
    const store = await db.storeLocation.findUnique({
      where: { id: filter.storeLocationId },
      select: { name: true },
    });
    if (!store) throw new EmailListError("That store doesn't exist.");
    // A register order records its store's id; an imported one, only the
    // name. NULL is named explicitly, so the name branch never matches an
    // order that has an id for another store (rule 51).
    order.OR = [
      { storeLocationId: filter.storeLocationId },
      { storeLocationId: null, storeLocation: { equals: store.name, mode: "insensitive" } },
    ];
  }
  return order;
}

/** The customers a filter selects: each with an email. */
export async function emailListWhere(
  db: Db,
  filter: EmailListFilter,
  timeZone: string,
): Promise<Prisma.CustomerWhereInput> {
  const and: Prisma.CustomerWhereInput[] = [{ email: { not: null } }, { NOT: { email: "" } }];
  if (filter.boughtFrom || filter.boughtTo || filter.storeLocationId) {
    and.push({ salesOrders: { some: await boughtWhere(db, filter, timeZone) } });
  }
  if (filter.minLevel !== undefined) and.push({ customerLevel: { gte: filter.minLevel } });
  if (filter.trade) and.push({ isTradeAccount: filter.trade === "trade" });
  if (filter.referralSourceId) and.push({ referralSourceId: filter.referralSourceId });
  return { AND: and };
}

export interface EmailListRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  customerLevel: number | null;
  trade: boolean;
  referralSource: string | null;
  lastOrderDate: Date | null;
}

export async function emailList(
  db: Db,
  filter: EmailListFilter,
  timeZone: string,
): Promise<EmailListRow[]> {
  const rows = await db.customer.findMany({
    where: await emailListWhere(db, filter, timeZone),
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    select: {
      email: true,
      firstName: true,
      lastName: true,
      customerLevel: true,
      isTradeAccount: true,
      lastOrderDate: true,
      referralSource: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    email: r.email as string,
    firstName: r.firstName,
    lastName: r.lastName,
    customerLevel: r.customerLevel,
    trade: r.isTradeAccount,
    referralSource: r.referralSource?.name ?? null,
    lastOrderDate: r.lastOrderDate,
  }));
}

export function emailListCsv(rows: EmailListRow[]): string {
  return (
    csvRow(["Email", "First name", "Last name", "Level", "Trade", "Heard of us", "Last order"]) +
    rows
      .map((r) =>
        csvRow([
          r.email,
          r.firstName,
          r.lastName,
          r.customerLevel,
          r.trade ? "yes" : "no",
          r.referralSource,
          r.lastOrderDate ? r.lastOrderDate.toISOString().slice(0, 10) : null,
        ]),
      )
      .join("")
  );
}
