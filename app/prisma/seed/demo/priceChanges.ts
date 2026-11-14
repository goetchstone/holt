// /app/prisma/seed/demo/priceChanges.ts
//
// GAP-06: a product's price history and a price lock. A demo store has marked a
// few items down in one mass price change (the old price becomes the was price,
// for a sale tag), and locked one price by hand so imports leave it alone.
//
// These go through the code staff use -- the mass change's own apply
// (lib/pricing/massChange.ts applyMassChangeInTx, which writes through
// lib/pricing/retailWriter.ts) and the writer's lock -- so the seed cannot write
// a ledger row or an audit entry the routes would not: the markdown's batch has
// its PRICES_ADJUSTED entry, as a run from the screen does. No RNG draws:
// products are taken by position, and this runs last, so nothing else the seed
// makes shifts.

import type { PrismaClient } from "@prisma/client";
import { setPriceLocks } from "@/lib/pricing/retailWriter";
import { applyMassChangeInTx } from "@/lib/pricing/massChange";
import { roundRetail } from "@/lib/pricing/rounding";
import type { CatalogProduct } from "./catalog";

const SEED_ACTOR = "seed:demo";
/** A fixed id for the demo's one mass change, so a re-seed reads the same. */
const BATCH_ID = "seed-demo-markdown";

export async function seedPriceChanges(
  prisma: PrismaClient,
  products: readonly CatalogProduct[],
): Promise<{ changed: number; locked: number }> {
  const priced = products.filter((p) => p.baseRetail > 0);
  const markdown = priced.slice(0, 4);
  const lockedOne = priced[4];

  return prisma.$transaction(async (tx) => {
    // Each product's prices as they stand, as a preview would show them: an
    // earlier step may have given one a was price.
    const current = await tx.product.findMany({
      where: { id: { in: markdown.map((p) => p.id) } },
      select: { id: true, baseRetail: true, wasPrice: true },
    });
    // Twenty percent off, to a price ending in .99; today's price becomes the was price.
    const result = await applyMassChangeInTx(
      tx,
      current.map((p) => {
        const fromRetail = Number(p.baseRetail);
        return {
          productId: p.id,
          fromRetail,
          toRetail: roundRetail(fromRetail * 0.8, "END_99"),
          fromWas: p.wasPrice === null ? null : Number(p.wasPrice),
          toWas: roundRetail(fromRetail, "CENTS"),
        };
      }),
      { actor: SEED_ACTOR, batchId: BATCH_ID, note: "Floor sample markdown" },
    );
    const locks = lockedOne
      ? await setPriceLocks(tx, [lockedOne.id], true, { actor: SEED_ACTOR, audit: "each" })
      : { changed: [] };
    return { changed: result.changed, locked: locks.changed.length };
  });
}
