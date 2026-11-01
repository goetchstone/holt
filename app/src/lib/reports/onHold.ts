// /app/src/lib/reports/onHold.ts
//
// On hold (GAP-16): every quote line holding floor stock for its customer
// today, soonest to end first -- who it is for, who quoted it, how many units
// the quote actually holds and where they sit. A quote holds a line through its
// last day (lib/sales/quoteHoldsShared.ts); the day after, the scheduled sweep
// puts the stock back on sale, so a hold whose day has passed is not listed.
//
// "Held" is what the quote really commits, not what the line asks for: a hold
// set when the piece was already sold elsewhere commits nothing, and shows as
// held 0 of 1, an oversale the Oversold report also lists.

import type { Prisma, PrismaClient } from "@prisma/client";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { csvRow } from "@/lib/csvExport";
import { holdDateString, holdDateValue, holdDaysLeft } from "@/lib/sales/quoteHoldsShared";

type Db = PrismaClient | Prisma.TransactionClient;

export interface OnHoldRow {
  salesOrderId: number;
  orderno: string | null;
  customerName: string | null;
  salesperson: string | null;
  storeName: string | null;
  lineItemId: number;
  productId: number;
  productName: string;
  partNo: string | null;
  /** What the line asks for. */
  quantity: number;
  /** What the quote commits for it. */
  held: number;
  /** Where the held units sit: "Store / Place". */
  places: string[];
  holdUntil: string;
  /** 0 on its last day. */
  daysLeft: number;
}

export async function getOnHoldReport(db: Db, today: string): Promise<OnHoldRow[]> {
  const lines = await db.orderLineItem.findMany({
    where: {
      holdUntil: { gte: holdDateValue(today) },
      lineItemStatus: "ACTIVE",
      productId: { not: null },
      salesOrder: { status: "QUOTE" },
    },
    select: {
      id: true,
      productId: true,
      productName: true,
      partNo: true,
      orderedQuantity: true,
      fulfilledQty: true,
      holdUntil: true,
      salesOrder: {
        select: {
          id: true,
          orderno: true,
          salesperson: true,
          storeLocation: true,
          customer: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: [{ holdUntil: "asc" }, { salesOrderId: "asc" }, { lineNumber: "asc" }, { id: "asc" }],
  });
  if (lines.length === 0) return [];

  const positions = await db.inventoryPosition.findMany({
    where: { salesOrderId: { in: [...new Set(lines.map((l) => l.salesOrder.id))] } },
    select: {
      salesOrderId: true,
      productId: true,
      quantity: true,
      storeLocation: { select: { name: true } },
      stockLocation: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });
  // Units each quote commits per product, and where; handed out to its held
  // lines in order, so two lines of one product don't both claim the same unit.
  const pool = new Map<string, { left: number; places: Set<string> }>();
  for (const p of positions) {
    const key = `${p.salesOrderId}|${p.productId}`;
    const entry = pool.get(key) ?? { left: 0, places: new Set<string>() };
    entry.left = roundQty(entry.left + toQty(p.quantity));
    entry.places.add(`${p.storeLocation.name} / ${p.stockLocation.name}`);
    pool.set(key, entry);
  }

  return lines.map((line) => {
    const productId = line.productId as number;
    const quantity = roundQty(
      Math.max(0, toQty(line.orderedQuantity) - toQty(line.fulfilledQty ?? 0)),
    );
    const entry = pool.get(`${line.salesOrder.id}|${productId}`);
    const held = entry ? Math.min(quantity, entry.left) : 0;
    if (entry) entry.left = roundQty(entry.left - held);
    const customer = line.salesOrder.customer;
    const holdUntil = holdDateString(line.holdUntil as Date);
    return {
      salesOrderId: line.salesOrder.id,
      orderno: line.salesOrder.orderno,
      customerName: customer
        ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null
        : null,
      salesperson: line.salesOrder.salesperson,
      storeName: line.salesOrder.storeLocation,
      lineItemId: line.id,
      productId,
      productName: line.productName ?? "",
      partNo: line.partNo,
      quantity,
      held,
      places: entry && held > 0 ? [...entry.places] : [],
      holdUntil,
      daysLeft: holdDaysLeft(holdUntil, today),
    };
  });
}

export function onHoldCsv(rows: OnHoldRow[]): string {
  return (
    csvRow([
      "Held until",
      "Days left",
      "Quote",
      "Customer",
      "Salesperson",
      "Store",
      "Product",
      "Part No",
      "Held",
      "Of",
      "Where",
    ]) +
    rows
      .map((r) =>
        csvRow([
          r.holdUntil,
          r.daysLeft,
          r.orderno,
          r.customerName,
          r.salesperson,
          r.storeName,
          r.productName,
          r.partNo,
          r.held,
          r.quantity,
          r.places.join("; "),
        ]),
      )
      .join("")
  );
}
