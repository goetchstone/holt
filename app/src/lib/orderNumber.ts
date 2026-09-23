// /app/src/lib/orderNumber.ts
//
// The next sales-order number: `<prefix>-YYMMDD-NNN`, numbered per business day.
//
// One function for every path that creates an order (principle 3: a guard on one
// path is no guard). This used to be pasted into create-from-cart and
// convert-to-order with one pilot's initials baked in, and both took the date
// from the SERVER's clock, so an order placed at 9 pm Eastern on a UTC server
// was numbered for tomorrow. The prefix is the business's (AppSettings,
// through numberingPrefix.effectivePrefix), and the date is the business day in
// the business's own timezone.

import type { Prisma } from "@prisma/client";
import { businessDayKey } from "@/lib/reports/businessDay";

type OrderClient = Pick<Prisma.TransactionClient, "salesOrder">;

/** The day stem, e.g. `HR-260923-`, for `now` as the business sees the date. */
export function orderNumberStem(prefix: string, timeZone: string, now: Date): string {
  const [yyyy, mm, dd] = businessDayKey(now, timeZone).split("-");
  return `${prefix}-${yyyy.slice(2)}${mm}${dd}-`;
}

/**
 * Next free number for the business day. Call inside the transaction that
 * creates the order: `orderno` is unique, so two concurrent orders racing for
 * one number fail loudly instead of sharing it.
 */
export async function nextOrderNumber(
  tx: OrderClient,
  prefix: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<string> {
  const stem = orderNumberStem(prefix, timeZone, now);
  const last = await tx.salesOrder.findFirst({
    where: { orderno: { startsWith: stem } },
    orderBy: { orderno: "desc" },
    select: { orderno: true },
  });
  const lastSeq = last ? Number.parseInt(last.orderno.slice(stem.length), 10) : 0;
  const seq = Number.isNaN(lastSeq) ? 1 : lastSeq + 1;
  return `${stem}${String(seq).padStart(3, "0")}`;
}
