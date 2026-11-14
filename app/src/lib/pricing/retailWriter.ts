// /app/src/lib/pricing/retailWriter.ts
//
// THE one writer for an existing product's retail (GAP-06, DECISIONS 58). Every
// path that changes Product.baseRetail or Product.wasPrice on a product that
// already exists goes through here -- a person editing one product, a mass price
// change, a vendor style edit, and each importer -- so three things hold on all
// of them at once (rule 42):
//
//   - a locked price (Product.priceLocked) is kept by anything automatic;
//   - every change is a ProductPriceChange row, from what to what, by whom and
//     through what, written in the same transaction as the change (money is
//     ledgered; there is no undo, only another change);
//   - a was price is above zero and every price is to the cent.
//
// Two entry points:
//
//   applyRetailChanges  -- for a deliberate change to known products: locks
//                          their rows, skips what is unchanged, locked or stale,
//                          writes the product and its ledger row.
//   lockRetailRows + retailFieldsForImport + recordImportPriceChanges
//                       -- for an importer that builds its own `update` object:
//                          it reads the row FOR UPDATE in the transaction that
//                          writes it, drops baseRetail when the product is
//                          locked, the file's cell is blank or the importer
//                          may not change prices, and hands back the ledger
//                          row for what did change.
//
// __tests__/retailWriters.test.ts fails on a file that writes baseRetail
// without being listed in __tests__/fixtures/retail-writers.txt.

import { Prisma, type PrismaClient } from "@prisma/client";
import { auditLog } from "@/lib/audit";
import type { PriceChangeSource } from "@/lib/pricing/priceChangeSources";
import { toCents } from "@/lib/pricing/rounding";

type Db = Prisma.TransactionClient | PrismaClient;
type MoneyLike = Prisma.Decimal | number | string | null | undefined;

/** A change someone asked for. A field left undefined is left alone. */
export interface RetailChange {
  productId: number;
  toRetail?: number | null;
  toWas?: number | null;
  /**
   * What the caller saw. When given, a product whose current value differs is
   * refused as stale rather than changed -- a mass change previews first, and
   * someone may have changed a price in between.
   */
  expectFromRetail?: number | null;
  expectFromWas?: number | null;
}

export interface RetailWriteOptions {
  source: PriceChangeSource;
  actor: string;
  batchId?: string | null;
  note?: string | null;
  /** true: a locked product is kept as it is. false: a person editing it on purpose. */
  honourLock: boolean;
  /**
   * "each": record PRODUCT_PRICE_CHANGED per changed product (one product, or a
   * style's few). "caller": the caller records one entry for the whole run.
   */
  audit: "each" | "caller";
}

export interface ChangedPrice {
  productId: number;
  name: string;
  fromRetail: number | null;
  toRetail: number | null;
  fromWas: number | null;
  toWas: number | null;
}

export interface RetailWriteResult {
  changed: ChangedPrice[];
  unchanged: number[];
  skippedLocked: number[];
  stale: number[];
  missing: number[];
}

/** A change the writer refuses outright: the caller should have caught it. */
export class RetailWriteError extends Error {}

/** A price as a number, or null. */
export function moneyOrNull(value: MoneyLike): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The same amount of money, to the cent. */
export function sameMoney(a: MoneyLike, b: MoneyLike): boolean {
  const x = moneyOrNull(a);
  const y = moneyOrNull(b);
  if (x === null || y === null) return x === y;
  return Math.round(x * 100) === Math.round(y * 100);
}

/** Why a price can't be written, or null. A retail may be zero or none; a was price is above zero. */
export function priceProblem(value: number | null, field: "retail" | "was"): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) return `The ${field} price must be zero or more.`;
  if (field === "was" && value === 0) return "The was price must be above zero.";
  // Decimal(12,2) in the ledger: under ten billion.
  if (value >= 1e10) return `The ${field} price is too large.`;
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    return `The ${field} price must be to the cent.`;
  }
  return null;
}

interface LockedRow {
  id: number;
  name: string;
  baseRetail: Prisma.Decimal | null;
  wasPrice: Prisma.Decimal | null;
  priceLocked: boolean;
}

/** The products' rows, locked FOR UPDATE in id order so two writers never deadlock. */
async function lockProducts(tx: Prisma.TransactionClient, ids: number[]): Promise<LockedRow[]> {
  if (ids.length === 0) return [];
  return tx.$queryRaw<LockedRow[]>`
    SELECT id, name, "baseRetail", "wasPrice", "priceLocked"
    FROM "Product"
    WHERE id = ANY(${ids}::int[])
    ORDER BY id
    FOR UPDATE`;
}

/** "retail 100 → 90", or null when it didn't move. */
export function priceMove(name: string, from: number | null, to: number | null): string | null {
  return sameMoney(from, to) ? null : `${name} ${from ?? "none"} → ${to ?? "none"}`;
}

/** The changes by product, refusing a duplicate. Prices are checked against each row (planRow). */
function indexChanges(changes: readonly RetailChange[]): Map<number, RetailChange> {
  const byId = new Map<number, RetailChange>();
  for (const change of changes) {
    if (!Number.isInteger(change.productId)) throw new RetailWriteError("A product id is needed.");
    if (byId.has(change.productId)) {
      throw new RetailWriteError(`Product ${change.productId} is listed twice.`);
    }
    byId.set(change.productId, change);
  }
  return byId;
}

/**
 * Why a target price can't be written onto this product, or null. A target that
 * is exactly the stored value is the caller sending it back unchanged, and is
 * not checked: a retail stored past the cent (an old import's unrounded markup)
 * must not refuse a run that only touches the was price.
 */
function targetProblem(
  row: LockedRow,
  to: number | null | undefined,
  current: number | null,
  field: "retail" | "was",
): string | null {
  if (to === undefined || to === current) return null;
  const problem = priceProblem(to, field);
  return problem && `${row.name} (product ${row.id}): ${problem}`;
}

/** What to do with one locked row: leave it (and why), or the prices it moves to. */
function planRow(
  row: LockedRow,
  change: RetailChange,
  honourLock: boolean,
): "stale" | "unchanged" | "locked" | ChangedPrice {
  const fromRetail = moneyOrNull(row.baseRetail);
  const fromWas = moneyOrNull(row.wasPrice);
  const problem =
    targetProblem(row, change.toRetail, fromRetail, "retail") ??
    targetProblem(row, change.toWas, fromWas, "was");
  if (problem) throw new RetailWriteError(problem);
  const moved = (expected: number | null | undefined, actual: number | null) =>
    expected !== undefined && !sameMoney(expected, actual);
  if (moved(change.expectFromRetail, fromRetail) || moved(change.expectFromWas, fromWas)) {
    return "stale";
  }
  const toRetail = change.toRetail === undefined ? fromRetail : change.toRetail;
  const toWas = change.toWas === undefined ? fromWas : change.toWas;
  if (sameMoney(fromRetail, toRetail) && sameMoney(fromWas, toWas)) return "unchanged";
  if (honourLock && row.priceLocked) return "locked";
  return { productId: row.id, name: row.name, fromRetail, toRetail, fromWas, toWas };
}

/** Write one change: the product, its ledger row, and (when asked) its audit entry. */
async function writeChange(
  tx: Prisma.TransactionClient,
  change: ChangedPrice,
  options: RetailWriteOptions,
): Promise<void> {
  const { productId, fromRetail, toRetail, fromWas, toWas } = change;
  const data: Prisma.ProductUpdateInput = { updatedBy: options.actor };
  if (!sameMoney(fromRetail, toRetail)) data.baseRetail = toRetail;
  if (!sameMoney(fromWas, toWas)) data.wasPrice = toWas;
  await tx.product.update({ where: { id: productId }, data });
  await tx.productPriceChange.create({
    data: {
      productId,
      fromRetail,
      toRetail,
      fromWas,
      toWas,
      source: options.source,
      batchId: options.batchId ?? null,
      note: options.note ?? null,
      actor: options.actor,
    },
  });
  if (options.audit !== "each") return;
  const moved = [
    priceMove("retail", fromRetail, toRetail),
    priceMove("was", fromWas, toWas),
  ].filter(Boolean);
  await auditLog(
    "PRODUCT_PRICE_CHANGED",
    options.actor,
    {
      summary: `${change.name}: ${moved.join(", ")}`,
      target: { type: "product", id: productId },
      details: { source: options.source, ...(options.batchId && { batchId: options.batchId }) },
    },
    tx,
  );
}

/**
 * Change existing products' retail and was price, inside the caller's
 * transaction. Refuses (throws RetailWriteError) a price that isn't one;
 * otherwise reports each product as changed, unchanged, locked, stale or missing.
 */
export async function applyRetailChanges(
  tx: Prisma.TransactionClient,
  changes: readonly RetailChange[],
  options: RetailWriteOptions,
): Promise<RetailWriteResult> {
  const byId = indexChanges(changes);
  const rows = await lockProducts(
    tx,
    [...byId.keys()].sort((a, b) => a - b),
  );
  const found = new Set(rows.map((r) => r.id));
  const result: RetailWriteResult = {
    changed: [],
    unchanged: [],
    skippedLocked: [],
    stale: [],
    missing: [...byId.keys()].filter((id) => !found.has(id)),
  };
  for (const row of rows) {
    const plan = planRow(row, byId.get(row.id)!, options.honourLock);
    if (plan === "stale") result.stale.push(row.id);
    else if (plan === "unchanged") result.unchanged.push(row.id);
    else if (plan === "locked") result.skippedLocked.push(row.id);
    else {
      await writeChange(tx, plan, options);
      result.changed.push(plan);
    }
  }
  return result;
}

export interface LockResult {
  changed: { productId: number; name: string }[];
  unchanged: number[];
  missing: number[];
}

/**
 * Lock or unlock products' prices, inside the caller's transaction, with one
 * PRICE_LOCK_CHANGED entry per product that changed (or one for the run when
 * the caller records it: `audit: "caller"`).
 */
export async function setPriceLocks(
  tx: Prisma.TransactionClient,
  productIds: readonly number[],
  locked: boolean,
  options: { actor: string; audit: "each" | "caller" },
): Promise<LockResult> {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  const rows = await lockProducts(tx, ids);
  const found = new Set(rows.map((r) => r.id));
  const result: LockResult = {
    changed: [],
    unchanged: [],
    missing: ids.filter((id) => !found.has(id)),
  };
  const toChange = rows.filter((r) => r.priceLocked !== locked);
  result.unchanged = rows.filter((r) => r.priceLocked === locked).map((r) => r.id);
  if (toChange.length === 0) return result;
  await tx.product.updateMany({
    where: { id: { in: toChange.map((r) => r.id) } },
    data: { priceLocked: locked, updatedBy: options.actor },
  });
  for (const row of toChange) {
    result.changed.push({ productId: row.id, name: row.name });
    if (options.audit === "each") {
      await auditLog(
        "PRICE_LOCK_CHANGED",
        options.actor,
        {
          summary: `${row.name}: price ${locked ? "locked" : "unlocked"}`,
          target: { type: "product", id: row.id },
        },
        tx,
      );
    }
  }
  return result;
}

// ─── Importers ─────────────────────────────────────────────────────────────

/** What an importer knows about the product it is about to update. */
export interface ExistingRetail {
  id: number;
  baseRetail: MoneyLike;
  wasPrice?: MoneyLike;
  priceLocked: boolean;
}

/**
 * Existing products' retail, was price and lock, read FOR UPDATE inside the
 * caller's transaction. An importer decides from these rows, never from a read
 * taken before its write's transaction (or once for a whole run): a price
 * locked, or changed by a mass change, while the import ran is then seen and
 * kept, and the ledger's "from" is the price the change actually replaced.
 */
export async function lockRetailRows(
  tx: Prisma.TransactionClient,
  ids: readonly number[],
): Promise<Map<number, ExistingRetail>> {
  const rows = await lockProducts(
    tx,
    [...new Set(ids)].sort((a, b) => a - b),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, baseRetail: r.baseRetail, wasPrice: r.wasPrice, priceLocked: r.priceLocked },
    ]),
  );
}

/** One product's row, as lockRetailRows. Throws when it is gone. */
export async function lockRetailRow(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<ExistingRetail> {
  const row = (await lockRetailRows(tx, [id])).get(id);
  if (!row) throw new RetailWriteError(`Product ${id} no longer exists.`);
  return row;
}

/**
 * Why an import kept a product's retail as it was: locked, no price in the
 * file, or the person importing may not change prices ("Change pricing").
 */
export type RetailKept = "locked" | "blank" | "permission";

/** A change an importer made, for its ledger row. */
export interface ImportPriceChange {
  productId: number;
  fromRetail: number | null;
  toRetail: number;
  fromWas: number | null;
}

export interface ImportRetailFields {
  /** Spread into the importer's update: holds baseRetail only when it may change. */
  data: { baseRetail?: number };
  /** Why the file's retail was not written, or null when it was (or matched). */
  kept: RetailKept | null;
  /** The ledger row to write once the update has, or null when nothing moved. */
  change: ImportPriceChange | null;
}

/**
 * The retail an importer may write onto an existing product.
 *
 * A blank, zero or unreadable cell means the file says nothing about the price,
 * so an existing product keeps its own: writing 0 makes it unsellable at the
 * register (lib/pos/cartPricing.ts catalogRetailPrice). A locked product keeps
 * its price whatever the file says. Otherwise the file's price, to the cent.
 */
export function retailFieldsForImport(
  existing: ExistingRetail,
  incoming: number | null | undefined,
  options: { mayChangePrice?: boolean } = {},
): ImportRetailFields {
  if (incoming === null || incoming === undefined || !Number.isFinite(incoming) || incoming <= 0) {
    return { data: {}, kept: "blank", change: null };
  }
  const toRetail = toCents(incoming) / 100;
  const fromRetail = moneyOrNull(existing.baseRetail);
  if (sameMoney(fromRetail, toRetail)) return { data: {}, kept: null, change: null };
  if (existing.priceLocked) return { data: {}, kept: "locked", change: null };
  // Changing an existing product's retail needs "Change pricing", as a hand
  // edit does (products/[id].ts): an import is not a way round it.
  if (options.mayChangePrice === false) return { data: {}, kept: "permission", change: null };
  return {
    data: { baseRetail: toRetail },
    kept: null,
    change: {
      productId: existing.id,
      fromRetail,
      toRetail,
      fromWas: moneyOrNull(existing.wasPrice),
    },
  };
}

/** How many products an import kept the price of, and why. */
export interface PriceKeptCounts {
  priceLockedKept: number;
  priceBlankKept: number;
  /** Kept because the person importing doesn't hold "Change pricing". */
  priceNoPermissionKept: number;
}

export function emptyKeptCounts(): PriceKeptCounts {
  return { priceLockedKept: 0, priceBlankKept: 0, priceNoPermissionKept: 0 };
}

export function countKept(counts: PriceKeptCounts, kept: RetailKept | null): void {
  if (kept === "locked") counts.priceLockedKept++;
  if (kept === "blank") counts.priceBlankKept++;
  if (kept === "permission") counts.priceNoPermissionKept++;
}

/** "price locked, kept: 2; no price in the file, kept: 5", or "" when none. */
export function keptSummary(counts: PriceKeptCounts): string {
  const parts: string[] = [];
  if (counts.priceLockedKept > 0) parts.push(`price locked, kept: ${counts.priceLockedKept}`);
  if (counts.priceBlankKept > 0) {
    parts.push(`no price in the file, kept: ${counts.priceBlankKept}`);
  }
  if (counts.priceNoPermissionKept > 0) {
    parts.push(`no permission to change prices, kept: ${counts.priceNoPermissionKept}`);
  }
  return parts.join("; ");
}

/** The ledger rows for an import's changes, for a createMany in its own transaction. */
export function importPriceChangeRows(
  changes: readonly ImportPriceChange[],
  options: { source: PriceChangeSource; actor: string | null | undefined; note?: string | null },
): Prisma.ProductPriceChangeCreateManyInput[] {
  return changes.map((c) => ({
    productId: c.productId,
    fromRetail: c.fromRetail,
    toRetail: c.toRetail,
    fromWas: c.fromWas,
    toWas: c.fromWas,
    source: options.source,
    note: options.note ?? null,
    actor: options.actor || "import",
  }));
}

/** Write an import's ledger rows, in the transaction that made the changes. */
export async function recordImportPriceChanges(
  db: Db,
  changes: readonly ImportPriceChange[],
  options: { source: PriceChangeSource; actor: string | null | undefined; note?: string | null },
): Promise<void> {
  if (changes.length === 0) return;
  await db.productPriceChange.createMany({ data: importPriceChangeRows(changes, options) });
}
