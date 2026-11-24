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

import type { NextApiResponse } from "next";
import type { PrismaClient, Prisma } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/** What a consignment route answers when no vendor is flagged as consigning. */
export const NO_CONSIGNMENT_VENDOR =
  "No consignment vendor configured. Set isConsignment on the vendor first.";

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

/**
 * The consigning vendor a route is about to write against, asked before the
 * route starts work. With none configured it answers 404 with
 * NO_CONSIGNMENT_VENDOR and returns null, and the route returns at once.
 *
 * Every route that needs the vendor asks here (rule 42). Four imports used to
 * throw that message from inside their transaction, so it reached the caller
 * only as a 500's body, which carries no error text (rule 11): "Import failed".
 * A deployment that does not consign is told so, the same way everywhere.
 */
export async function consignmentVendorOr404(
  prisma: Client,
  res: NextApiResponse,
): Promise<number | null> {
  const vendorId = await getPrimaryConsignmentVendorId(prisma);
  if (vendorId === null) res.status(404).json({ error: NO_CONSIGNMENT_VENDOR });
  return vendorId;
}

/** Prisma filter for "products from a consigning vendor". */
export async function consignmentVendorFilter(
  prisma: Client,
): Promise<{ vendorId: { in: number[] } }> {
  return { vendorId: { in: await getConsignmentVendorIds(prisma) } };
}
