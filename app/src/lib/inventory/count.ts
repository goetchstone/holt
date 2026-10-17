// /app/src/lib/inventory/count.ts
//
// Count by place (ledger plan phase 17; DECISIONS #21). A count says what is
// physically at one place, product by product. Posting it compares that with
// the books -- everything at the place, free and committed -- and moves the
// difference as ADJUST movements, so the journal says a count changed it.
//
//   - Found more than the books: the extra is added as free stock.
//   - Found less: free stock goes first; then units committed to orders,
//     whose orders are resynced (they re-commit stock from elsewhere, or show
//     on the Oversold report as short).
//   - A PLACE count also says what is not there: a product on the books there
//     but not counted was counted absent. A PRODUCTS count (a quick count)
//     speaks only for what it lists.
//
// Counting is `inventory.count`; posting, which changes the books, is
// `inventory.adjust`.

import type { Prisma } from "@prisma/client";
import { lockProducts, postMovement, type Place } from "./ledger";
import { roundQty, toQty, qtyIsZero } from "./quantity";
import { LOCATION_TYPE_INFO, isStockLocationType } from "./locationTypes";
import { resyncOrderAllocation } from "./orderInventorySync";
import { clearBoxNote } from "./boxNotes";

type Tx = Prisma.TransactionClient;

export const STOCK_COUNT_SCOPES = {
  PLACE: "Everything at the place: what is not counted is not there",
  PRODUCTS: "Only the products counted (a quick count)",
} as const;
export type StockCountScope = keyof typeof STOCK_COUNT_SCOPES;

export const STOCK_COUNT_STATUSES = {
  SUBMITTED: "Counted, waiting to be posted",
  POSTED: "Posted: the books were changed to match",
  CANCELLED: "Cancelled: the books were not changed",
} as const;

export class CountError extends Error {}

export interface BookAtPlace {
  productId: number;
  free: number;
  committed: number;
}

export interface CountDifference {
  productId: number;
  counted: number;
  expected: number;
  difference: number;
  addFree: number;
  removeFree: number;
  removeCommitted: number;
}

/** Pure: what posting a count moves, product by product. */
export function countDifference(
  lines: { productId: number; counted: number }[],
  book: BookAtPlace[],
  scope: StockCountScope,
): CountDifference[] {
  const counted = new Map<number, number>();
  for (const l of lines) {
    counted.set(l.productId, roundQty((counted.get(l.productId) ?? 0) + l.counted));
  }
  const books = new Map(book.map((b) => [b.productId, b]));
  const products =
    scope === "PLACE" ? new Set([...counted.keys(), ...books.keys()]) : new Set(counted.keys());
  const out: CountDifference[] = [];
  for (const productId of [...products].sort((a, b) => a - b)) {
    const b = books.get(productId) ?? { productId, free: 0, committed: 0 };
    const c = counted.get(productId) ?? 0;
    const expected = roundQty(b.free + b.committed);
    const difference = roundQty(c - expected);
    const short = difference < 0 ? -difference : 0;
    const removeFree = Math.min(b.free, short);
    out.push({
      productId,
      counted: c,
      expected,
      difference,
      addFree: difference > 0 ? difference : 0,
      removeFree,
      removeCommitted: roundQty(short - removeFree),
    });
  }
  return out;
}

/** What the books hold at a place, per product. */
export async function bookAtPlace(tx: Tx, stockLocationId: number): Promise<BookAtPlace[]> {
  const rows = await tx.inventoryPosition.findMany({
    where: { stockLocationId },
    select: { productId: true, salesOrderId: true, quantity: true },
  });
  const byProduct = new Map<number, BookAtPlace>();
  for (const r of rows) {
    const b = byProduct.get(r.productId) ?? { productId: r.productId, free: 0, committed: 0 };
    if (r.salesOrderId == null) b.free = roundQty(b.free + toQty(r.quantity));
    else b.committed = roundQty(b.committed + toQty(r.quantity));
    byProduct.set(r.productId, b);
  }
  return [...byProduct.values()];
}

export async function submitCount(
  tx: Tx,
  args: {
    storeLocationId: number;
    stockLocationId: number;
    scope: StockCountScope;
    lines: { productId: number; counted: number; boxes?: number[] }[];
    actor: string | null;
    note?: string | null;
  },
): Promise<{ id: number }> {
  const place = await tx.stockLocation.findUnique({
    where: { id: args.stockLocationId },
    select: { storeLocationId: true, locationType: true, name: true },
  });
  if (!place || place.storeLocationId !== args.storeLocationId) {
    throw new CountError("That place is not at this store.");
  }
  if (
    isStockLocationType(place.locationType) &&
    !LOCATION_TYPE_INFO[place.locationType].holdsStock
  ) {
    throw new CountError(`"${place.name}" groups places; count each place inside it.`);
  }
  if (args.scope === "PRODUCTS" && args.lines.length === 0) {
    throw new CountError("A quick count needs at least one product.");
  }
  const merged = new Map<number, { counted: number; boxes: number[] }>();
  for (const l of args.lines) {
    if (!Number.isInteger(l.productId)) throw new CountError("Each line needs a product.");
    if (!Number.isFinite(l.counted) || l.counted < 0) {
      throw new CountError("A count cannot be negative.");
    }
    const m = merged.get(l.productId) ?? { counted: 0, boxes: [] };
    m.counted = roundQty(m.counted + l.counted);
    m.boxes.push(...(l.boxes ?? []));
    merged.set(l.productId, m);
  }
  return tx.stockCount.create({
    data: {
      storeLocationId: args.storeLocationId,
      stockLocationId: args.stockLocationId,
      scope: args.scope,
      status: "SUBMITTED",
      countedBy: args.actor,
      note: args.note ?? null,
      lines: {
        create: [...merged].map(([productId, m]) => ({
          productId,
          counted: m.counted,
          boxes: m.boxes,
        })),
      },
    },
    select: { id: true },
  });
}

/** What posting the count would move now, without moving it. */
export async function previewCount(tx: Tx, countId: number): Promise<CountDifference[]> {
  const count = await tx.stockCount.findUniqueOrThrow({
    where: { id: countId },
    include: { lines: true },
  });
  return countDifference(
    count.lines.map((l) => ({ productId: l.productId, counted: toQty(l.counted) })),
    await bookAtPlace(tx, count.stockLocationId),
    count.scope as StockCountScope,
  );
}

export async function postCount(
  tx: Tx,
  countId: number,
  args: { actor: string | null; actionKey?: string | null },
): Promise<CountDifference[]> {
  const count = await tx.stockCount.findUniqueOrThrow({
    where: { id: countId },
    include: { lines: true },
  });
  if (count.status !== "SUBMITTED") {
    throw new CountError(`This count is ${count.status.toLowerCase()}, not waiting to be posted.`);
  }
  const claimed = await tx.stockCount.updateMany({
    where: { id: countId, status: "SUBMITTED" },
    data: { status: "POSTED", postedAt: new Date(), postedBy: args.actor },
  });
  if (claimed.count === 0) throw new CountError("This count was just posted by someone else.");

  const book = await bookAtPlace(tx, count.stockLocationId);
  await lockProducts(tx, [
    ...new Set([...book.map((b) => b.productId), ...count.lines.map((l) => l.productId)]),
  ]);
  const diffs = countDifference(
    count.lines.map((l) => ({ productId: l.productId, counted: toQty(l.counted) })),
    // Re-read under the locks: the plan must be true when it is applied.
    await bookAtPlace(tx, count.stockLocationId),
    count.scope as StockCountScope,
  );
  const free: Place = {
    storeLocationId: count.storeLocationId,
    stockLocationId: count.stockLocationId,
    salesOrderId: null,
  };
  const base = {
    reason: "ADJUST" as const,
    source: { type: "StockCount" as const, id: count.id },
    actor: args.actor,
    note: `Count #${count.id}`,
    actionKey: args.actionKey,
  };
  const shortOrders = new Set<number>();

  for (const d of diffs) {
    if (d.addFree > 0) {
      await postMovement(tx, { ...base, productId: d.productId, quantity: d.addFree, to: free });
    }
    if (d.removeFree > 0) {
      await postMovement(tx, {
        ...base,
        productId: d.productId,
        quantity: d.removeFree,
        from: free,
      });
    }
    let committed = d.removeCommitted;
    if (committed > 0) {
      const held = await tx.inventoryPosition.findMany({
        where: {
          productId: d.productId,
          stockLocationId: count.stockLocationId,
          salesOrderId: { not: null },
        },
        orderBy: { id: "desc" },
      });
      for (const row of held) {
        if (committed <= 0 || qtyIsZero(committed)) break;
        const take = Math.min(toQty(row.quantity), committed);
        await postMovement(tx, {
          ...base,
          productId: d.productId,
          quantity: take,
          from: { ...free, salesOrderId: row.salesOrderId },
        });
        shortOrders.add(row.salesOrderId!);
        committed = roundQty(committed - take);
      }
    }
    const line = count.lines.find((l) => l.productId === d.productId);
    if (line) {
      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { expected: d.expected, difference: d.difference },
      });
    } else {
      // Counted absent: on the books here, and not found.
      await tx.stockCountLine.create({
        data: {
          countId: count.id,
          productId: d.productId,
          counted: 0,
          boxes: [],
          expected: d.expected,
          difference: d.difference,
        },
      });
    }
  }

  // Box notes the count answers: a stray box that was not scanned here, or an
  // incomplete set counted absent, is not here any more.
  const counted = new Map(count.lines.map((l) => [l.productId, l]));
  const notes = await tx.boxNote.findMany({
    where: { stockLocationId: count.stockLocationId, clearedAt: null },
  });
  for (const n of notes) {
    const line = counted.get(n.productId);
    if (count.scope === "PRODUCTS" && !line) continue;
    const absent =
      n.kind === "STRAY"
        ? !n.boxes.every((b) => line?.boxes.includes(b))
        : !line || toQty(line.counted) === 0;
    if (absent)
      await clearBoxNote(tx, n.id, {
        reason: `Counted absent (count #${count.id})`,
        actor: args.actor,
      });
  }

  for (const orderId of shortOrders) {
    const order = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { storeLocation: true },
    });
    await resyncOrderAllocation(orderId, order?.storeLocation, tx);
  }
  return diffs;
}

export async function cancelCount(tx: Tx, countId: number, actor: string | null): Promise<void> {
  const r = await tx.stockCount.updateMany({
    where: { id: countId, status: "SUBMITTED" },
    data: { status: "CANCELLED", postedAt: new Date(), postedBy: actor },
  });
  if (r.count === 0) throw new CountError("Only a count waiting to be posted can be cancelled.");
}
