// /app/src/lib/inventory/stocked.ts
//
// Which products go on the books (GAP-21). A product is stocked unless the
// store set its category not to track inventory (Category.trackInventory): a
// service, a fee, a warranty, supplies. An item made to order is an item like
// any other: it is on order until its PO arrives and stock after.
//
// What isn't stocked never gains stock. The ledger refuses a movement that
// brings its units onto the books from outside (lib/inventory/ledger.ts), so
// every path is covered, and the paths that meet one ordinarily say why first:
// a receipt records it and stocks nothing, a return puts nothing back, a count
// or an import can take it down but not up. Stock it already held when its
// category was switched off stays on the books, movable and countable, until
// someone counts it out (owner, 2026-11-02).

import type { PrismaTx } from "./ledger";

/** Whether a sale draws a product from stock and stock can hold it. */
export function isStockedProduct(product: {
  category: { trackInventory: boolean } | null;
}): boolean {
  return product.category?.trackInventory ?? true;
}

/** Selects what isStockedProduct reads. */
export const STOCKED_SELECT = { category: { select: { trackInventory: true } } } as const;

/** Why a product can't take stock: its category keeps none. */
export function notStockedMessage(product: {
  name: string;
  category: { name: string } | null;
}): string {
  return `${product.name} isn't stocked: its category, ${product.category?.name}, doesn't track inventory.`;
}

/** Units of a product that isn't stocked were about to come onto the books. */
export class NotStockedError extends Error {
  constructor(
    readonly productId: number,
    message: string,
  ) {
    super(message);
    this.name = "NotStockedError";
  }
}

/** The products among these that aren't stocked, each with why. */
export async function notStocked(db: PrismaTx, productIds: number[]): Promise<Map<number, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.product.findMany({
    where: { id: { in: [...new Set(productIds)] }, category: { trackInventory: false } },
    select: { id: true, name: true, category: { select: { name: true } } },
  });
  return new Map(rows.map((p) => [p.id, notStockedMessage(p)]));
}
