// /app/src/lib/reports/transfersReport.ts
//
// Transfers (GAP-17): what moved between stores in a period, by route and one by
// one, and what is still on its way.
//
// POPULATION (principle 2)
//
// A transfer belongs to the day it was sent (shippedAt; its creation day if it
// never shipped). `moved`, the default, is what actually left: IN_TRANSIT and
// RECEIVED. A draft moved nothing and a cancelled transfer came back, so neither
// is in those totals; each has its own view. Zero-quantity rows are out (rule 31).
//
// `in_transit` ignores the period. A transfer sent four months ago and never
// received is exactly what someone is looking for here, and a date range must
// not hide it. inTransitNow reports the same set on every view.
//
// Cost goes only to a holder of "View cost", at today's cost: no history of cost
// is kept (transfersReportForCaller).

import { Prisma, type PrismaClient } from "@prisma/client";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { productCostSql } from "@/lib/purchasing/landedCost";
import { TRANSFER_VIEWS, type TransferView } from "@/lib/reports/transfersReportShared";
import { businessDayKey, businessDayRange, daysBetween, isDayKey } from "@/lib/reports/businessDay";

const UNIT_COST = Prisma.raw(productCostSql("p"));

/** Rows listed; totals and routes always cover the whole population. */
export const TRANSFER_ROW_LIMIT = 500;

export class TransfersReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransfersReportInputError";
  }
}

export interface TransferRouteRow {
  from: string;
  to: string;
  transfers: number;
  units: number;
  /** Units that have arrived. */
  received: number;
  costValue: number;
}

export interface TransferRow {
  id: number;
  productId: number;
  productNumber: string;
  productName: string;
  quantity: number;
  received: number;
  from: string;
  fromPlace: string | null;
  to: string;
  toPlace: string | null;
  status: string;
  /** The store day it was sent, or created if it never was. */
  sentOn: string;
  receivedOn: string | null;
  /** Whole days since it was sent, while it is on its way. */
  daysOnTheWay: number | null;
  costValue: number;
}

export interface TransfersReportResult {
  view: TransferView;
  startDate: string;
  endDate: string;
  storeLocationId: number | null;
  totals: { transfers: number; units: number; received: number; costValue: number };
  routes: TransferRouteRow[];
  rows: TransferRow[];
  inTransitNow: { transfers: number; units: number; oldestDays: number | null };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function statusesSql(view: TransferView): Prisma.Sql {
  return Prisma.sql`t.status::text = ANY(${[...TRANSFER_VIEWS[view].statuses]}::text[])`;
}

function storeSql(storeLocationId: number | null): Prisma.Sql {
  return Prisma.sql`(${storeLocationId}::int IS NULL
    OR t."fromLocationId" = ${storeLocationId}::int
    OR t."toLocationId" = ${storeLocationId}::int)`;
}

interface RawRoute {
  from_name: string;
  to_name: string;
  transfers: number;
  units: number | null;
  received: number | null;
  cost_value: number | null;
}

interface RawRow {
  id: number;
  productId: number;
  productNumber: string;
  productName: string;
  quantity: number;
  received: number;
  from_name: string;
  from_place: string | null;
  to_name: string;
  to_place: string | null;
  status: string;
  sent_at: Date;
  receivedAt: Date | null;
  unit_cost: number | null;
}

export async function getTransfersReport(
  prisma: PrismaClient,
  input: {
    startDate: string;
    endDate: string;
    view?: TransferView;
    storeLocationId?: number | null;
  },
): Promise<TransfersReportResult> {
  const { startDate, endDate } = input;
  if (!isDayKey(startDate) || !isDayKey(endDate)) {
    throw new TransfersReportInputError("Choose dates as YYYY-MM-DD.");
  }
  if (startDate > endDate) {
    throw new TransfersReportInputError("The start date must be on or before the end date.");
  }

  const timeZone = await getBusinessTimeZone();
  const today = businessDayKey(new Date(), timeZone);
  const view: TransferView = input.view ?? "moved";
  const storeLocationId = input.storeLocationId ?? null;

  const gte = businessDayRange(startDate, timeZone).gte;
  const lt = businessDayRange(endDate, timeZone).lt;
  const inPeriod =
    view === "in_transit"
      ? Prisma.sql`TRUE`
      : Prisma.sql`COALESCE(t."shippedAt", t.created) >= ${gte}
          AND COALESCE(t."shippedAt", t.created) < ${lt}`;
  const where = Prisma.sql`t.quantity > 0 AND ${statusesSql(view)} AND ${storeSql(storeLocationId)}
    AND ${inPeriod}`;

  const FROM_NAME = Prisma.sql`COALESCE(fs.name, t."fromLocation")`;
  const TO_NAME = Prisma.sql`COALESCE(ts.name, t."toLocation")`;
  const JOINS = Prisma.sql`
    FROM "InventoryTransfer" t
    JOIN "Product" p ON p.id = t."productId"
    LEFT JOIN "StoreLocation" fs ON fs.id = t."fromLocationId"
    LEFT JOIN "StoreLocation" ts ON ts.id = t."toLocationId"`;

  const [rawRoutes, rawRows, inTransit] = await Promise.all([
    prisma.$queryRaw<RawRoute[]>`
      SELECT ${FROM_NAME} AS from_name, ${TO_NAME} AS to_name,
             COUNT(*)::int AS transfers,
             SUM(t.quantity)::float8 AS units,
             SUM(t."receivedQuantity")::float8 AS received,
             SUM(t.quantity * ${UNIT_COST})::float8 AS cost_value
      ${JOINS}
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY units DESC, 1, 2
    `,
    prisma.$queryRaw<RawRow[]>`
      SELECT t.id, t."productId", p."productNumber", p.name AS "productName",
             t.quantity::float8 AS quantity,
             t."receivedQuantity"::float8 AS received,
             ${FROM_NAME} AS from_name, fp.name AS from_place,
             ${TO_NAME} AS to_name, tp.name AS to_place,
             t.status,
             COALESCE(t."shippedAt", t.created) AS sent_at,
             t."receivedAt",
             (${UNIT_COST})::float8 AS unit_cost
      ${JOINS}
      LEFT JOIN "StockLocation" fp ON fp.id = t."fromStockLocationId"
      LEFT JOIN "StockLocation" tp ON tp.id = t."toStockLocationId"
      WHERE ${where}
      ORDER BY COALESCE(t."shippedAt", t.created) DESC, t.id DESC
      LIMIT ${TRANSFER_ROW_LIMIT}
    `,
    prisma.$queryRaw<{ transfers: number; units: number | null; oldest: Date | null }[]>`
      SELECT COUNT(*)::int AS transfers,
             SUM(t.quantity - t."receivedQuantity")::float8 AS units,
             MIN(COALESCE(t."shippedAt", t.created)) AS oldest
      FROM "InventoryTransfer" t
      WHERE t.quantity > 0 AND ${statusesSql("in_transit")} AND ${storeSql(storeLocationId)}
    `,
  ]);

  const routes: TransferRouteRow[] = rawRoutes.map((r) => ({
    from: r.from_name,
    to: r.to_name,
    transfers: r.transfers,
    units: round3(Number(r.units) || 0),
    received: round3(Number(r.received) || 0),
    costValue: round2(Number(r.cost_value) || 0),
  }));

  const rows: TransferRow[] = rawRows.map((r) => {
    const sentOn = businessDayKey(r.sent_at, timeZone);
    return {
      id: r.id,
      productId: r.productId,
      productNumber: r.productNumber,
      productName: r.productName,
      quantity: r.quantity,
      received: r.received,
      from: r.from_name,
      fromPlace: r.from_place,
      to: r.to_name,
      toPlace: r.to_place,
      status: r.status,
      sentOn,
      receivedOn: r.receivedAt ? businessDayKey(r.receivedAt, timeZone) : null,
      daysOnTheWay: r.status === "IN_TRANSIT" ? daysBetween(sentOn, today) : null,
      costValue: round2(r.quantity * (r.unit_cost ?? 0)),
    };
  });

  const totals = routes.reduce(
    (sum, r) => ({
      transfers: sum.transfers + r.transfers,
      units: round3(sum.units + r.units),
      received: round3(sum.received + r.received),
      costValue: round2(sum.costValue + r.costValue),
    }),
    { transfers: 0, units: 0, received: 0, costValue: 0 },
  );

  const now = inTransit[0];
  return {
    view,
    startDate,
    endDate,
    storeLocationId,
    totals,
    routes,
    rows,
    inTransitNow: {
      transfers: now.transfers,
      units: round3(Number(now.units) || 0),
      oldestDays: now.oldest ? daysBetween(businessDayKey(now.oldest, timeZone), today) : null,
    },
  };
}

/** The report for one viewer: every cost field goes without "View cost". */
export function transfersReportForCaller(result: TransfersReportResult, showCost: boolean) {
  if (showCost) return { ...result, costVisible: true as const };
  return {
    ...result,
    totals: {
      transfers: result.totals.transfers,
      units: result.totals.units,
      received: result.totals.received,
    },
    routes: result.routes.map((r) => ({
      from: r.from,
      to: r.to,
      transfers: r.transfers,
      units: r.units,
      received: r.received,
    })),
    rows: result.rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      productNumber: r.productNumber,
      productName: r.productName,
      quantity: r.quantity,
      received: r.received,
      from: r.from,
      fromPlace: r.fromPlace,
      to: r.to,
      toPlace: r.toPlace,
      status: r.status,
      sentOn: r.sentOn,
      receivedOn: r.receivedOn,
      daysOnTheWay: r.daysOnTheWay,
    })),
    costVisible: false as const,
  };
}
