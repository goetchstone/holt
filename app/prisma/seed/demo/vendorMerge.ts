// /app/prisma/seed/demo/vendorMerge.ts
//
// GAP-22: a duplicate vendor merged into the one the store keeps. An import
// once spelled the demo supplier "Brightwater Trade", which made a second
// vendor with a contact of its own. Merging it through lib/vendors/mergeVendor.ts
// -- the code staff use -- moves the contact over and leaves the old spelling
// as an earlier name, so the vendor screen shows "Earlier names" and the next
// import that spells it finds the supplier.
//
// No RNG draws, and it runs after seedProductSources, so nothing else the seed
// makes shifts.

import type { PrismaClient } from "@prisma/client";
import { mergeVendor } from "@/lib/vendors/mergeVendor";

const SEED_ACTOR = "seed:demo";

/** The invented misspelling an import once made of the demo supplier. */
export const DUPLICATE_NAME = "Brightwater Trade";

export async function seedVendorMerge(
  prisma: PrismaClient,
  keptName: string,
): Promise<{ merged: string; into: string; moved: number }> {
  const kept = await prisma.vendor.findUniqueOrThrow({ where: { name: keptName } });
  if (await prisma.vendorAlias.findUnique({ where: { name: DUPLICATE_NAME } })) {
    return { merged: DUPLICATE_NAME, into: kept.name, moved: 0 };
  }
  const duplicate = await prisma.vendor.create({
    data: { name: DUPLICATE_NAME, phone: "757-555-0142", createdBy: SEED_ACTOR },
  });
  await prisma.vendorContact.create({
    data: {
      vendorId: duplicate.id,
      name: "Dana Whitlock",
      role: "Sales rep",
      email: "dana@bwts.example.com",
      phone: "757-555-0142",
    },
  });
  const plan = await mergeVendor(prisma, duplicate.id, kept.id, SEED_ACTOR);
  return {
    merged: plan.from.name,
    into: plan.into.name,
    moved: plan.moves.reduce((n, m) => n + m.count, 0),
  };
}
