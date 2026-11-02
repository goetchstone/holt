// /app/prisma/seed/demo/productSources.ts
//
// GAP-22: items bought from more than one vendor. One invented supplier sells
// the demo store a few items from two catalog vendors, under its own item
// numbers and at its own cost, so the product screen shows "Other vendors" and
// a PO to that supplier offers those items. One more item can also be bought
// from a second catalog vendor with no number or cost of its own, the case
// where the PO falls back to the item's.
//
// These go through lib/purchasing/productSources.ts -- the code staff use -- so
// the seed cannot write a row the routes would refuse. No RNG draws: products
// are taken by position, and this runs after everything else, so nothing else
// the seed makes shifts.

import type { PrismaClient } from "@prisma/client";
import { addProductSource } from "@/lib/purchasing/productSources";
import type { CatalogProduct } from "./catalog";

const SEED_ACTOR = "seed:demo";

/** An invented company that sells several lines -- not a real distributor. */
export const SUPPLIER_NAME = "Brightwater Trade Supply";

export async function seedProductSources(
  prisma: PrismaClient,
  vendorIds: readonly number[],
  products: readonly CatalogProduct[],
): Promise<{ sources: number; vendors: number }> {
  const supplier = await prisma.vendor.upsert({
    where: { name: SUPPLIER_NAME },
    update: {},
    create: {
      name: SUPPLIER_NAME,
      code: "BWTS",
      pricingModel: "FLAT",
      accountNumber: "ACC-40517",
      paymentTerms: "Net 30",
      freightTerms: "FOB Destination",
      city: "Norfolk",
      state: "VA",
      email: "orders@bwts.example.com",
      leadTimeDays: 21,
      createdBy: SEED_ACTOR,
    },
  });

  const who = { canSetCost: true, by: SEED_ACTOR };
  let sources = 0;
  const [first, second] = vendorIds;
  for (const vendorId of [first, second]) {
    for (const p of products.filter((x) => x.vendorId === vendorId).slice(0, 3)) {
      await addProductSource(
        prisma,
        p.id,
        {
          vendorId: supplier.id,
          itemNumber: `BW-${p.productNumber}`,
          // A supplier's few points over the maker's own price.
          cost: Math.round(p.baseCost * 104) / 100,
        },
        who,
      );
      sources++;
    }
  }
  const crossOver = products.find((x) => x.vendorId === first);
  if (crossOver && second !== undefined) {
    await addProductSource(prisma, crossOver.id, { vendorId: second }, who);
    sources++;
  }
  return { sources, vendors: 2 };
}
