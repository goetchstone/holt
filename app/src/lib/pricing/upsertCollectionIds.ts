// /app/src/lib/pricing/upsertCollectionIds.ts
//
// Upsert a vendor's collections by name and return name → Collection.id.
// Shared by the pricing import routes, which each carried a copy of this loop.

import type { Prisma } from "@prisma/client";

type CollectionClient = Pick<Prisma.TransactionClient, "collection">;

/**
 * Collection names come from the uploaded price list, so the lookup is a Map,
 * not a plain object: a collection named `__proto__` is lost on write to `{}`,
 * and `constructor` or `toString` read back an inherited function instead of
 * "not found". A Map has no inherited keys.
 */
export async function upsertCollectionIds(
  tx: CollectionClient,
  vendorId: number,
  names: Iterable<string>,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const name of names) {
    if (ids.has(name)) continue;
    const collection = await tx.collection.upsert({
      where: { vendorId_name: { vendorId, name } },
      create: { vendorId, name },
      update: {},
    });
    ids.set(name, collection.id);
  }
  return ids;
}
