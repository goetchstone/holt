// /app/src/lib/inventory/importSync.ts
//
// The POS stock import as a client of the ledger (plan phase 5).
//
// A stock file states, for each (product, POS location), how many are on hand.
// Holt owns its stock, so on a live site this is a one-time opening load; the
// owner's daily import exists for testing. Either way the file is applied the
// same way, as movements through lib/inventory/ledger.ts:
//
//   planImportSync   pure. Turns the file's rows into one target per place:
//                    the PHYSICAL quantity the file says is there.
//                      - rows that resolve to the same place are summed (two POS
//                        names aliased to one Holt place, or several unmatched
//                        names in the catch-all), each row clamped at zero
//                        first: the POS reports a negative when it has sold more
//                        than it held, and a place cannot hold less than nothing;
//                      - a zero row is a target of zero, not a skipped row;
//                      - a place the file covers (any row resolved to it) that
//                        holds a product the file does not list there is set to
//                        zero -- the file is the whole truth for the places it
//                        covers, and says nothing about the ones it does not.
//   applyImportSync  writes the plan. Under each product's lock it reads what is
//                    committed to orders at the place and sets FREE stock to
//                    physical minus committed (never below zero), so an import
//                    never takes back stock a sale has already committed. A
//                    second run of the same file finds every place already at
//                    its target and writes nothing (rule 63).

import type { Prisma } from "@prisma/client";
import { lockProducts, setPlaceQuantity, withStockTx, type PrismaTx } from "./ledger";
import { roundQty, toQty } from "./quantity";

/** One stock-file row, resolved to a product and a Holt place. */
export interface ImportStockRow {
  productId: number;
  storeLocationId: number;
  stockLocationId: number;
  /** On hand as the file states it; may be zero or negative. */
  quantity: number;
  /** The POS location name, when it matched no Holt place (catch-all rows). */
  unmatchedName?: string | null;
}

/** A product holding stock at a place before the import runs. */
export interface HeldAtPlace {
  productId: number;
  storeLocationId: number;
  stockLocationId: number;
}

export interface ImportTarget {
  productId: number;
  storeLocationId: number;
  stockLocationId: number;
  /** What the file says is physically there. */
  physical: number;
  /** For catch-all places: which POS names the units came from. undefined = leave the note alone. */
  note?: string;
}

const key = (p: { productId: number; storeLocationId: number; stockLocationId: number }) =>
  `${p.productId}|${p.storeLocationId}|${p.stockLocationId}`;

/** Pure: the file's rows, and what is held at the places it covers, as one target per place. */
export function planImportSync(rows: ImportStockRow[], held: HeldAtPlace[]): ImportTarget[] {
  const targets = new Map<string, ImportTarget & { names: Set<string> }>();
  const covered = new Set<number>();

  for (const row of rows) {
    if (!Number.isFinite(row.quantity)) continue;
    covered.add(row.stockLocationId);
    const k = key(row);
    const target = targets.get(k) ?? {
      productId: row.productId,
      storeLocationId: row.storeLocationId,
      stockLocationId: row.stockLocationId,
      physical: 0,
      names: new Set<string>(),
    };
    target.physical = roundQty(target.physical + Math.max(0, row.quantity));
    if (row.unmatchedName) target.names.add(row.unmatchedName);
    targets.set(k, target);
  }

  for (const h of held) {
    if (!covered.has(h.stockLocationId) || targets.has(key(h))) continue;
    targets.set(key(h), { ...h, physical: 0, names: new Set() });
  }

  return Array.from(targets.values()).map(({ names, ...target }) =>
    names.size > 0
      ? { ...target, note: `Unmatched CSV location: ${[...names].sort().join(", ")}` }
      : target,
  );
}

export interface ImportSyncResult {
  /** Places whose free stock changed. */
  placesChanged: number;
  /** Places where the file says fewer than are already committed to orders:
   *  the commitments are kept, free stock is zero, and the difference is here. */
  shortOfCommitted: {
    productId: number;
    stockLocationId: number;
    physical: number;
    committed: number;
  }[];
}

/** How many products' targets one transaction applies. */
const APPLY_BATCH = 100;

/** Write a plan through the ledger, a batch of products per transaction. */
export async function applyImportSync(
  db: PrismaTx,
  targets: ImportTarget[],
  actor: string | null,
): Promise<ImportSyncResult> {
  const result: ImportSyncResult = { placesChanged: 0, shortOfCommitted: [] };
  const byProduct = new Map<number, ImportTarget[]>();
  for (const t of targets) {
    const list = byProduct.get(t.productId) ?? [];
    list.push(t);
    byProduct.set(t.productId, list);
  }
  const productIds = Array.from(byProduct.keys()).sort((a, b) => a - b);

  for (let i = 0; i < productIds.length; i += APPLY_BATCH) {
    const batch = productIds.slice(i, i + APPLY_BATCH);
    await withStockTx(db, async (tx) => {
      await lockProducts(tx, batch);
      for (const productId of batch) {
        for (const t of byProduct.get(productId)!) {
          const committed = await committedAt(tx, t);
          if (committed > t.physical) {
            result.shortOfCommitted.push({
              productId,
              stockLocationId: t.stockLocationId,
              physical: t.physical,
              committed,
            });
          }
          const changed = await setPlaceQuantity(tx, {
            productId,
            place: {
              storeLocationId: t.storeLocationId,
              stockLocationId: t.stockLocationId,
              salesOrderId: null,
            },
            target: Math.max(0, roundQty(t.physical - committed)),
            reason: "IMPORT_SYNC",
            actor,
            note: t.note,
          });
          if (changed !== 0) result.placesChanged++;
        }
      }
    });
  }
  return result;
}

async function committedAt(tx: Prisma.TransactionClient, t: ImportTarget): Promise<number> {
  const agg = await tx.inventoryPosition.aggregate({
    where: {
      productId: t.productId,
      storeLocationId: t.storeLocationId,
      stockLocationId: t.stockLocationId,
      salesOrderId: { not: null },
    },
    _sum: { quantity: true },
  });
  return toQty(agg._sum.quantity);
}
