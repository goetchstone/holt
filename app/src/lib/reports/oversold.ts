// /app/src/lib/reports/oversold.ts
//
// The Oversold report (ledger plan phase 11). Overselling is allowed on
// purpose (DECISIONS #14): a sale commits what free stock exists and records
// the rest as an InventoryException. This turns those rows into work:
//
//   - one open row per (order, product), however many times the order is
//     edited and re-synced (recordShortfalls updates it rather than adding);
//   - each row closes itself once the order holds what it needs
//     (settleShortfalls, called wherever stock is committed to an order: a
//     sale or line edit, a receipt for the order, a transfer arriving for it);
//   - grouped by product, each with a suggested fix: free stock somewhere
//     else, units on an open PO and when they are due, or nothing on order --
//     start a draft PO.
//
// Whether the product's last count by area showed a variance is a flag the
// count-by-area pages add (ledger plan PR 4).

import type { Prisma, PrismaClient } from "@prisma/client";
import { freePositionWhere } from "@/lib/inventory/allocation";
import { roundQty, toQty } from "@/lib/inventory/quantity";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Close the order's open exceptions it now holds enough stock for, and bring
 * the rest up to date with what is still short.
 */
export async function settleShortfalls(db: Db, orderId: number): Promise<void> {
  const open = await db.inventoryException.findMany({
    where: { salesOrderId: orderId, resolvedAt: null },
    select: { id: true, productId: true },
  });
  for (const ex of open) {
    const [need, held] = await Promise.all([
      db.orderLineItem.aggregate({
        where: { salesOrderId: orderId, productId: ex.productId, lineItemStatus: "ACTIVE" },
        _sum: { orderedQuantity: true },
      }),
      db.inventoryPosition.aggregate({
        where: { salesOrderId: orderId, productId: ex.productId },
        _sum: { quantity: true },
      }),
    ]);
    const requested = toQty(need._sum.orderedQuantity);
    const allocated = Math.min(requested, toQty(held._sum.quantity));
    const shortfall = roundQty(requested - allocated);
    await db.inventoryException.update({
      where: { id: ex.id },
      data:
        shortfall > 0
          ? { requested, allocated, shortfall }
          : {
              requested,
              allocated,
              shortfall: 0,
              resolvedAt: new Date(),
              resolvedBy: "system",
              resolutionNote: "Covered: the order now holds the stock it needs.",
            },
    });
  }
}

export type SuggestedFix =
  | { kind: "FREE_HERE"; storeName: string; quantity: number }
  | { kind: "FREE_ELSEWHERE"; storeName: string; quantity: number }
  | { kind: "ON_PO"; poNumber: string; quantity: number; due: Date | null }
  | { kind: "ORDER_IT" };

/**
 * Pure: the most direct way to cover a shortfall. Free stock at the store the
 * order was sold at comes first -- it only needs committing (re-saving the
 * order commits it) -- then free stock at another store, which needs a
 * transfer, then units already on an open PO, earliest due.
 */
export function suggestFix(args: {
  shortfall: number;
  freeByStore: { storeName: string; quantity: number; orderStore: boolean }[];
  openPoLines: { poNumber: string; outstanding: number; due: Date | null }[];
}): SuggestedFix {
  const withStock = [...args.freeByStore]
    .filter((s) => s.quantity > 0)
    .sort((a, b) => Number(b.orderStore) - Number(a.orderStore) || b.quantity - a.quantity);
  const free = withStock[0];
  if (free) {
    return {
      kind: free.orderStore ? "FREE_HERE" : "FREE_ELSEWHERE",
      storeName: free.storeName,
      quantity: free.quantity,
    };
  }
  const po = [...args.openPoLines]
    .filter((l) => l.outstanding > 0)
    .sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity))[0];
  if (po) return { kind: "ON_PO", poNumber: po.poNumber, quantity: po.outstanding, due: po.due };
  return { kind: "ORDER_IT" };
}

export interface OversoldRow {
  productId: number;
  productName: string;
  partNo: string | null;
  shortfall: number;
  orders: {
    orderno: string;
    salesOrderId: number;
    storeName: string;
    shortfall: number;
    since: Date;
  }[];
  fix: SuggestedFix;
  /**
   * The product's last posted count that found a difference (lib/inventory/
   * count.ts): a shortfall right after a count that came up short may be a
   * miscount, not an oversale. Null when its last count matched, or none.
   */
  lastCountVariance: { countedAt: Date; place: string; difference: number } | null;
}

/** Open exceptions grouped by product, each with its suggested fix. */
export async function getOversoldReport(
  db: Db,
  filter: { storeLocationId?: number | null } = {},
): Promise<OversoldRow[]> {
  const open = await db.inventoryException.findMany({
    where: {
      resolvedAt: null,
      shortfall: { gt: 0 },
      ...(filter.storeLocationId ? { storeLocationId: filter.storeLocationId } : {}),
    },
    include: {
      product: { select: { name: true, productNumber: true } },
      salesOrder: { select: { orderno: true } },
      storeLocation: { select: { name: true } },
    },
    orderBy: { occurredAt: "asc" },
  });

  const byProduct = new Map<number, typeof open>();
  for (const ex of open) {
    const list = byProduct.get(ex.productId) ?? [];
    list.push(ex);
    byProduct.set(ex.productId, list);
  }

  const rows: OversoldRow[] = [];
  for (const [productId, list] of byProduct) {
    const shortfall = roundQty(list.reduce((s, ex) => s + toQty(ex.shortfall), 0));
    const [free, poLines] = await Promise.all([
      db.inventoryPosition.groupBy({
        by: ["storeLocationId"],
        where: { AND: [freePositionWhere(), { productId }] },
        _sum: { quantity: true },
      }),
      db.purchaseOrderItem.findMany({
        where: {
          productId,
          purchaseOrder: { status: { notIn: ["CANCELLED", "RECEIVED_FULL", "SHORT_CLOSED"] } },
        },
        select: {
          orderedQuantity: true,
          receivingRecords: { select: { quantityReceived: true } },
          purchaseOrder: { select: { poNumber: true, expectedDelivery: true } },
        },
      }),
    ]);
    const storeNames = new Map(
      (
        await db.storeLocation.findMany({
          where: { id: { in: free.map((f) => f.storeLocationId) } },
          select: { id: true, name: true },
        })
      ).map((s) => [s.id, s.name]),
    );
    const lastLine = await db.stockCountLine.findFirst({
      where: { productId, count: { status: "POSTED" } },
      orderBy: { count: { postedAt: "desc" } },
      select: {
        difference: true,
        count: { select: { countedAt: true, stockLocation: { select: { name: true } } } },
      },
    });
    const lastDifference = toQty(lastLine?.difference);
    rows.push({
      productId,
      productName: list[0].product.name,
      partNo: list[0].product.productNumber,
      shortfall,
      orders: list.map((ex) => ({
        orderno: ex.salesOrder.orderno,
        salesOrderId: ex.salesOrderId,
        storeName: ex.storeLocation.name,
        shortfall: toQty(ex.shortfall),
        since: ex.occurredAt,
      })),
      fix: suggestFix({
        shortfall,
        freeByStore: free.map((f) => ({
          storeName: storeNames.get(f.storeLocationId) ?? `Store ${f.storeLocationId}`,
          quantity: toQty(f._sum.quantity),
          orderStore: list.some((ex) => ex.storeLocationId === f.storeLocationId),
        })),
        openPoLines: poLines.map((l) => ({
          poNumber: l.purchaseOrder.poNumber,
          outstanding: roundQty(
            toQty(l.orderedQuantity) -
              l.receivingRecords.reduce((s, r) => s + toQty(r.quantityReceived), 0),
          ),
          due: l.purchaseOrder.expectedDelivery,
        })),
      }),
      lastCountVariance:
        lastLine && lastDifference !== 0
          ? {
              countedAt: lastLine.count.countedAt,
              place: lastLine.count.stockLocation.name,
              difference: lastDifference,
            }
          : null,
    });
  }
  return rows.sort((a, b) => b.shortfall - a.shortfall);
}

/** The report as CSV, one row per order short of a product. */
export function oversoldCsv(rows: OversoldRow[]): string {
  const cell = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const fixText = (f: SuggestedFix) => {
    if (f.kind === "FREE_HERE")
      return `${f.quantity} free at ${f.storeName}: commit it to the order`;
    if (f.kind === "FREE_ELSEWHERE") return `${f.quantity} free at ${f.storeName}: transfer it`;
    if (f.kind === "ON_PO") {
      return `${f.quantity} on ${f.poNumber}${f.due ? ` due ${f.due.toISOString().slice(0, 10)}` : ""}`;
    }
    return "Nothing on order: start a draft PO";
  };
  const lines = [
    [
      "Product",
      "Part No",
      "Order",
      "Store",
      "Short",
      "Since",
      "Suggested fix",
      "Last count off by",
    ].join(","),
  ];
  for (const r of rows) {
    for (const o of r.orders) {
      lines.push(
        [
          cell(r.productName),
          cell(r.partNo),
          cell(o.orderno),
          cell(o.storeName),
          cell(o.shortfall),
          cell(o.since.toISOString().slice(0, 10)),
          cell(fixText(r.fix)),
          cell(r.lastCountVariance?.difference ?? null),
        ].join(","),
      );
    }
  }
  return lines.join("\n") + "\n";
}
