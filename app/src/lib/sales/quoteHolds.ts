// /app/src/lib/sales/quoteHolds.ts
//
// GAP-16: a quote holds floor stock for its customer until a date, and an order
// commits everything. The rule itself is lib/sales/quoteHoldsShared.ts, and
// resyncOrderAllocation applies it; this file is every path that changes which
// rule applies (rule 42 -- one function per path, so none can be missed):
//
//   promoteQuoteToOrder  a quote becomes an order: payment, a status change.
//                        Its lines all commit now, held or not.
//   setLineHold          staff hold a quote line until a day, or take the hold off.
//   endQuoteHolds        a quote is archived: the customer said no, so its holds end.
//   releaseExpiredHolds  the scheduled sweep: holds past their day go back on sale.
//
// A handover straight from a quote (markHandedOver, lib/fulfilment/handover.ts)
// resyncs as the order it has become before consuming, for the same reason.

import type { Prisma, PrismaClient } from "@prisma/client";
import { getAppSettings } from "@/lib/appSettings";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { logError } from "@/lib/logger";
import {
  holdDateProblem,
  holdDateValue,
  holdDateString,
  isStockedProduct,
  lineHoldProblem,
} from "./quoteHoldsShared";
import { businessDayKey } from "@/lib/reports/businessDay";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** Today on the store's clock and the longest hold it allows. */
export async function quoteHoldContext(
  now: Date = new Date(),
): Promise<{ today: string; maxDays: number }> {
  const settings = await getAppSettings();
  return { today: businessDayKey(now, settings.timezone), maxDays: settings.quoteHoldMaxDays };
}

/**
 * A quote becomes an order, and every line commits stock. Returns false (and
 * does nothing) when the order was not a quote. The status moves only from
 * QUOTE, in one statement, so two payments arriving together promote it once.
 */
export async function promoteQuoteToOrder(
  tx: Tx,
  orderId: number,
  actor?: string | null,
): Promise<boolean> {
  const promoted = await tx.salesOrder.updateMany({
    where: { id: orderId, status: "QUOTE" },
    data: { status: "ORDER", ...(actor ? { updatedBy: actor } : {}) },
  });
  if (promoted.count === 0) return false;
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { storeLocation: true },
  });
  await resyncOrderAllocation(orderId, order.storeLocation, tx);
  return true;
}

/** The customer said no: a quote's holds end and its stock goes back on sale. */
export async function endQuoteHolds(tx: Tx, orderId: number): Promise<void> {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, storeLocation: true },
  });
  if (order.status !== "QUOTE") return;
  await tx.orderLineItem.updateMany({
    where: { salesOrderId: orderId, holdUntil: { not: null } },
    data: { holdUntil: null },
  });
  // Resynced even with no hold to end: a quote written before holds existed
  // committed every line, and archiving it lets that go too.
  await resyncOrderAllocation(orderId, order.storeLocation, tx);
}

export class HoldError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "HoldError";
  }
}

/**
 * Hold a quote line's stock until `holdUntil` ("YYYY-MM-DD", the store's day),
 * or take the hold off with null. Only a quote's active floor-stock line, and
 * never past the store's longest hold. Commits or releases its units at once.
 * Throws HoldError with what the caller got wrong.
 */
export async function setLineHold(
  tx: Tx,
  args: { orderId: number; lineItemId: number; holdUntil: string | null; actor: string | null },
  ctx: { today: string; maxDays: number },
): Promise<{ holdUntil: string | null }> {
  const line = await tx.orderLineItem.findFirst({
    where: { id: args.lineItemId, salesOrderId: args.orderId },
    select: {
      holdUntil: true,
      lineItemStatus: true,
      source: true,
      product: { select: { madeToOrder: true, category: { select: { trackInventory: true } } } },
      salesOrder: { select: { status: true, storeLocation: true } },
    },
  });
  if (!line) throw new HoldError("Line item not found.", 404);
  if (line.salesOrder.status !== "QUOTE") {
    throw new HoldError("Only a quote holds stock; an order already commits every line.", 409);
  }
  if (args.holdUntil !== null) {
    const lineProblem = lineHoldProblem({
      lineItemStatus: line.lineItemStatus,
      source: line.source,
      stocked: line.product ? isStockedProduct(line.product) : null,
    });
    if (lineProblem) throw new HoldError(lineProblem, 409);
    const dateProblem = holdDateProblem(args.holdUntil, ctx);
    if (dateProblem) throw new HoldError(dateProblem, 400);
  }

  const before = line.holdUntil ? holdDateString(line.holdUntil) : null;
  if (before === args.holdUntil) return { holdUntil: before };

  await tx.orderLineItem.update({
    where: { id: args.lineItemId },
    data: { holdUntil: args.holdUntil === null ? null : holdDateValue(args.holdUntil) },
  });
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: args.orderId,
      lineItemId: args.lineItemId,
      changeType: args.holdUntil === null ? "HOLD_ENDED" : "HOLD_SET",
      previousValue: before,
      newValue: args.holdUntil,
      changedBy: args.actor,
    },
  });
  await resyncOrderAllocation(args.orderId, line.salesOrder.storeLocation, tx);
  return { holdUntil: args.holdUntil };
}

export interface ExpiredHoldSweep {
  /** Quotes that held stock when the sweep looked. */
  checked: number;
  /** Of those, the ones it released stock from. */
  released: number;
  /** Units back on sale. */
  units: number;
}

/**
 * Put back on sale the stock of every quote that holds more than its open holds
 * need: a hold whose last day has passed, and a quote written before holds
 * existed (when every quote committed every line). Each quote is resynced in
 * its own transaction, so one that fails is logged and the rest still go.
 * Running it twice releases nothing the second time.
 */
export async function releaseExpiredHolds(db: PrismaClient): Promise<ExpiredHoldSweep> {
  const quotes = await db.salesOrder.findMany({
    where: { status: "QUOTE", inventoryPositions: { some: {} } },
    select: { id: true, storeLocation: true },
    orderBy: { id: "asc" },
  });
  const result: ExpiredHoldSweep = { checked: quotes.length, released: 0, units: 0 };
  for (const quote of quotes) {
    try {
      const units = await db.$transaction(async (tx) => {
        const before = await committedUnits(tx, quote.id);
        await resyncOrderAllocation(quote.id, quote.storeLocation, tx);
        return roundQty(before - (await committedUnits(tx, quote.id)));
      });
      if (units > 0) {
        result.released++;
        result.units = roundQty(result.units + units);
      }
    } catch (err) {
      logError(`releaseExpiredHolds: could not resync quote ${quote.id}`, err);
    }
  }
  return result;
}

async function committedUnits(db: Db, orderId: number): Promise<number> {
  const sum = await db.inventoryPosition.aggregate({
    where: { salesOrderId: orderId },
    _sum: { quantity: true },
  });
  return toQty(sum._sum.quantity);
}
