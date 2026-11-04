// /app/src/lib/vendors/vendorByName.ts
//
// GAP-22: finding a vendor by a name from outside the database: a column in an
// import file, a line in a POS cart, a name the code itself spells. A vendor
// merged into another (lib/vendors/mergeVendor.ts) left its name behind as an
// alias (VendorAlias), and every lookup here finds the kept vendor through it.
// Without that, the next import that spells the old name makes the duplicate
// again. __tests__/vendorNameLookups.test.ts fails when code finds or creates a
// vendor by name anywhere else (rule 65).
//
// A vendor's own name wins over an alias, and an exact match wins over one
// that only matches ignoring case. Each caller keeps the matching it had:
// exact, or ignoring case.

import { Prisma, type PrismaClient } from "@prisma/client";

type Db = Pick<PrismaClient, "vendor" | "vendorAlias"> | Prisma.TransactionClient;

export interface NameMatch {
  /** Match "AMBERLIN" to "Amberlin". Off: the name must match exactly. */
  ignoreCase?: boolean;
}

export interface FoundVendor {
  id: number;
  name: string;
  /** The earlier name it was found by, or null when found by its own name. */
  alias: string | null;
}

function nameWhere(names: readonly string[], ignoreCase: boolean) {
  return ignoreCase ? { in: [...names], mode: "insensitive" as const } : { in: [...names] };
}

/** Exact before ignoring case, then the oldest. */
function best<T extends { name: string; id: number }>(rows: T[], name: string): T | undefined {
  const lower = name.toLowerCase();
  return rows
    .filter((r) => r.name.toLowerCase() === lower)
    .sort((a, b) => Number(b.name === name) - Number(a.name === name) || a.id - b.id)[0];
}

/**
 * The vendors for many names at once, by the name as given. A name no vendor
 * or alias matches is absent from the map.
 */
export async function findVendorsByName(
  db: Db,
  names: readonly string[],
  { ignoreCase = false }: NameMatch = {},
): Promise<Map<string, FoundVendor>> {
  const wanted = [...new Set(names)];
  const found = new Map<string, FoundVendor>();
  if (wanted.length === 0) return found;
  const vendors = await db.vendor.findMany({
    where: { name: nameWhere(wanted, ignoreCase) },
    select: { id: true, name: true },
  });
  for (const name of wanted) {
    const vendor = ignoreCase ? best(vendors, name) : vendors.find((v) => v.name === name);
    if (vendor) found.set(name, { id: vendor.id, name: vendor.name, alias: null });
  }
  const rest = wanted.filter((n) => !found.has(n));
  if (rest.length === 0) return found;
  const aliases = await db.vendorAlias.findMany({
    where: { name: nameWhere(rest, ignoreCase) },
    select: { id: true, name: true, vendor: { select: { id: true, name: true } } },
  });
  for (const name of rest) {
    const alias = ignoreCase ? best(aliases, name) : aliases.find((a) => a.name === name);
    if (alias) found.set(name, { id: alias.vendor.id, name: alias.vendor.name, alias: alias.name });
  }
  return found;
}

/** The vendor a name means, by its own name or an earlier one; null when none. */
export async function findVendorByName(
  db: Db,
  name: string,
  match: NameMatch = {},
): Promise<FoundVendor | null> {
  return (await findVendorsByName(db, [name], match)).get(name) ?? null;
}

/** The id of the vendor a name means; null when none. */
export async function vendorIdByName(
  db: Db,
  name: string,
  match: NameMatch = {},
): Promise<number | null> {
  return (await findVendorByName(db, name, match))?.id ?? null;
}

/**
 * The vendor a name means, made under that name when there is none. `data` is
 * what a new vendor gets besides its name.
 */
export async function findOrCreateVendor(
  db: Db,
  name: string,
  match: NameMatch & { data?: Omit<Prisma.VendorUncheckedCreateInput, "name"> } = {},
): Promise<{ id: number; name: string }> {
  const found = await findVendorByName(db, name, match);
  if (found) return { id: found.id, name: found.name };
  return db.vendor.create({ data: { ...match.data, name }, select: { id: true, name: true } });
}

/** The id of the vendor a name means, made under that name when there is none. */
export async function findOrCreateVendorId(
  db: Db,
  name: string,
  match: NameMatch & { data?: Omit<Prisma.VendorUncheckedCreateInput, "name"> } = {},
): Promise<number> {
  return (await findOrCreateVendor(db, name, match)).id;
}

/**
 * Every vendor name and earlier name, lowercased, to its vendor's id: for a
 * runner that matches thousands of rows against the whole list. A vendor's
 * own name wins over an alias that lowercases the same.
 */
export async function vendorNameIndex(db: Db): Promise<Map<string, number>> {
  const [vendors, aliases] = await Promise.all([
    db.vendor.findMany({ select: { id: true, name: true }, orderBy: { id: "asc" } }),
    db.vendorAlias.findMany({ select: { name: true, vendorId: true }, orderBy: { id: "asc" } }),
  ]);
  const index = new Map<string, number>();
  for (const v of vendors) {
    const key = v.name.toLowerCase();
    if (!index.has(key)) index.set(key, v.id);
  }
  for (const a of aliases) {
    const key = a.name.toLowerCase();
    if (!index.has(key)) index.set(key, a.vendorId);
  }
  return index;
}

/**
 * The id a name means in an index from vendorNameIndex, made under that name
 * when there is none. What it makes goes into the index, so the next row with
 * the name finds it.
 */
export async function findOrCreateInIndex(
  db: Db,
  index: Map<string, number>,
  name: string,
  data: Omit<Prisma.VendorUncheckedCreateInput, "name"> = {},
): Promise<number> {
  const key = name.toLowerCase();
  const known = index.get(key);
  if (known !== undefined) return known;
  const { id } = await db.vendor.create({ data: { ...data, name }, select: { id: true } });
  index.set(key, id);
  return id;
}
