// /app/src/lib/purchasing/reorderPoints.ts
//
// GAP-14: setting "keep at least this many here" on a product, per store (the
// product page, /api/products/[id]/reorder-points). What isn't stocked can't take
// one: it never has stock to fall short.

import type { Prisma } from "@prisma/client";
import { parseQty } from "@/lib/inventory/qtyInput";
import { isStockedProduct, notStockedMessage } from "@/lib/inventory/stocked";

type Db = Pick<Prisma.TransactionClient, "reorderPoint" | "product" | "storeLocation">;

export class ReorderPointError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "ReorderPointError";
  }
}

/** The product's reorder points, and the stores that could have one. */
export async function reorderPointsFor(db: Db, productId: number) {
  const [points, stores] = await Promise.all([
    db.reorderPoint.findMany({
      where: { productId },
      select: { storeLocationId: true, minQuantity: true, orderQuantity: true },
    }),
    db.storeLocation.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return {
    points: points.map((p) => ({
      storeLocationId: p.storeLocationId,
      minQuantity: Number(p.minQuantity),
      orderQuantity: p.orderQuantity == null ? null : Number(p.orderQuantity),
    })),
    stores,
  };
}

function readLeastOrder(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const quantity = parseQty(raw);
  if (quantity == null) throw new ReorderPointError("The least to order must be above zero.");
  return quantity;
}

export async function setReorderPoint(
  db: Db,
  input: {
    productId: number;
    storeLocationId: unknown;
    minQuantity: unknown;
    orderQuantity: unknown;
    actor: string | null;
  },
) {
  const minQuantity = parseQty(input.minQuantity);
  if (minQuantity == null) {
    throw new ReorderPointError(
      "Say how many to keep, above zero. To stop keeping any, remove it.",
    );
  }
  const orderQuantity = readLeastOrder(input.orderQuantity);
  const storeLocationId = Number(input.storeLocationId);
  const store = Number.isInteger(storeLocationId)
    ? await db.storeLocation.findUnique({
        where: { id: storeLocationId },
        select: { isActive: true },
      })
    : null;
  if (!store?.isActive) throw new ReorderPointError("That store isn't open.");
  const product = await db.product.findUnique({
    where: { id: input.productId },
    select: { name: true, category: { select: { name: true, trackInventory: true } } },
  });
  if (!product) throw new ReorderPointError("Product not found.", 404);
  if (!isStockedProduct(product)) throw new ReorderPointError(notStockedMessage(product));

  await db.reorderPoint.upsert({
    where: { productId_storeLocationId: { productId: input.productId, storeLocationId } },
    create: {
      productId: input.productId,
      storeLocationId,
      minQuantity,
      orderQuantity,
      createdBy: input.actor,
    },
    update: { minQuantity, orderQuantity, updatedBy: input.actor },
  });
}

export async function removeReorderPoint(db: Db, productId: number, storeLocationId: unknown) {
  await db.reorderPoint.deleteMany({
    where: { productId, storeLocationId: Number(storeLocationId) },
  });
}
