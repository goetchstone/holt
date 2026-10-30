// /app/src/lib/purchasing/poNumber.ts
//
// The one place a native purchase order gets its number: PO-YYMMDD-NNN, the
// business day it was raised and its place in that day. Used by the
// special-order draft (lib/paymentService.ts) and the stock POs a buyer writes
// (lib/purchasing/stockPurchaseOrder.ts), so the two can't number differently.
//
// The next number is read, then written; two POs raised at the same moment can
// read the same one. The unique index on poNumber refuses the second, and it is
// numbered again rather than failing the request.

import type { Prisma, PrismaClient } from "@prisma/client";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { businessDayStamp } from "@/lib/reports/businessDay";
import { getErrorCode } from "@/lib/errorCode";

const ATTEMPTS = 5;

type PoDb = Pick<PrismaClient, "purchaseOrder">;

/**
 * The next free number for the business day `now` falls on. The day's numbers
 * are compared as numbers, not text: "-1000" sorts before "-999" as text, so
 * the thousandth PO of a day would read 999 as the last and collide forever.
 */
export async function nextPoNumber(db: PoDb, now: Date, timeZone: string): Promise<string> {
  const prefix = `PO-${businessDayStamp(now, timeZone)}-`;
  const today = await db.purchaseOrder.findMany({
    where: { poNumber: { startsWith: prefix } },
    select: { poNumber: true },
  });
  const last = today.reduce((max, po) => {
    const seq = Number(po.poNumber.slice(prefix.length));
    return Number.isInteger(seq) && seq > max ? seq : max;
  }, 0);
  return `${prefix}${(last + 1).toString().padStart(3, "0")}`;
}

/**
 * Create a purchase order (and any nested lines) under the next free number.
 * Not for use inside a transaction: a refused insert aborts it, so the retry
 * could never run.
 */
export async function createNumberedPurchaseOrder(
  db: PoDb,
  data: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "poNumber">,
  now: Date = new Date(),
): Promise<{ id: number; poNumber: string }> {
  const timeZone = await getBusinessTimeZone();
  for (let attempt = 1; ; attempt++) {
    const poNumber = await nextPoNumber(db, now, timeZone);
    try {
      return await db.purchaseOrder.create({
        data: { ...data, poNumber },
        select: { id: true, poNumber: true },
      });
    } catch (err) {
      if (getErrorCode(err) !== "P2002" || attempt >= ATTEMPTS) throw err;
    }
  }
}
