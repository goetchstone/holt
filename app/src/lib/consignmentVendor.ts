// /app/src/lib/consignmentVendor.ts
//
// Finding "the consignment vendor" without knowing its name.
//
// Routes used to resolve it with `where: { name: { contains: "Marjan" } }` --
// 38 references across 12 files, one import route carrying six spellings, and
// an ILIKE in orderLineItemLinker's raw SQL. That worked for exactly one
// deployment and broke quietly for a second consignor, or for a rename.
//
// Vendor.isConsignment is the fact those lookups were reaching for. Consignment
// changes real behaviour -- stock that is not ours to value, a sale that creates
// money owed rather than margin, a return that is a vendor return rather than a
// write-off -- so it is a property of the vendor, not of its spelling.
//
// PLURAL BY DEFAULT. Nothing here assumes one consignor. Where a caller
// genuinely needs a single vendor to write against, it says so and handles the
// "none configured" case explicitly rather than inventing one.

import type { PrismaClient, Prisma } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/** Every consigning vendor. Empty when the deployment does not consign. */
export async function getConsignmentVendorIds(prisma: Client): Promise<number[]> {
  const rows = await prisma.vendor.findMany({
    where: { isConsignment: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id);
}

/**
 * The single consigning vendor to write new records against.
 *
 * Returns null when none is configured. Callers must handle that rather than
 * creating one: a route that invents a vendor when it cannot find one turns a
 * configuration mistake into a permanent junk row, which is how a catalog ends
 * up with "Marjan", "Marjan Intl" and "MARJANINT" as three different suppliers.
 *
 * With several configured, the lowest id wins and it is deterministic. That is a
 * real limitation, not a hidden one: a deployment consigning from two vendors
 * needs the caller to be told WHICH, and the honest fix is a parameter on those
 * routes rather than a guess here.
 */
export async function getPrimaryConsignmentVendorId(prisma: Client): Promise<number | null> {
  const ids = await getConsignmentVendorIds(prisma);
  return ids[0] ?? null;
}

/** Prisma filter for "products from a consigning vendor". */
export async function consignmentVendorFilter(
  prisma: Client,
): Promise<{ vendorId: { in: number[] } }> {
  return { vendorId: { in: await getConsignmentVendorIds(prisma) } };
}
