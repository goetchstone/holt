// /app/src/pages/api/import/inventory-snapshot.ts
//
// POS on-hand snapshot import -- CUTOVER / PARALLEL-RUN TOOL, not the normal
// Step 1. That's now POST /api/inventory/snapshot/generate, which builds the
// baseline from holt's own InventoryPosition (see that file, and
// InventorySnapshot's schema comment in prisma/schema.prisma, for why: this
// importer used to be the ONLY writer of InventorySnapshot, keyed on the
// POS's product id, so every product created natively in holt was silently
// absent from its own count).
//
// Kept for the migration window -- comparing a POS export against holt's own
// LOCAL snapshot is how you validate the cutover before trusting it fully.
// Resolves POS identifiers to holt's own before writing:
//   externalId (POS)        -> Product.externalId  -> productId
//   Stocklocation (POS text) -> StockLocation.locationAliases (case-insensitive,
//                                trimmed) -> its storeLocationId / stockLocationId
// A row that resolves to no product or no location is REPORTED (count +
// samples), never silently dropped -- an unresolvable row is exactly the
// signal that a mapping (a missing alias, or a product's externalId) needs
// attention, same rule the daily Stock-by-Item import follows for locations
// (docs/domains/inventory.md).
//
// The per-row skip/invalid/unresolved/ok decision lives in
// lib/inventory/snapshotImport.ts as a pure function -- this handler just
// preloads the two resolution maps and switches on the result (rule 14).
// resolveSnapshotImportRow checks product before location, so a row that
// fails both is reported once, as unresolvedProduct.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getErrorMessage } from "@/lib/toastError";
import {
  resolveSnapshotImportRow,
  type ResolvedSnapshotImportRow,
  type SnapshotImportMaps,
} from "@/lib/inventory/snapshotImport";

const SAMPLE_LIMIT = 20;

interface UnresolvedSample {
  data: unknown;
  message: string;
}

/** Count + capped sample list for one "why rows didn't resolve" bucket. */
class SampleBucket {
  count = 0;
  samples: UnresolvedSample[] = [];

  record(sample: UnresolvedSample): void {
    this.count++;
    if (this.samples.length < SAMPLE_LIMIT) this.samples.push(sample);
  }
}

/** Write one resolved row; returns an error message on failure, null on success. */
async function persistResolvedRow(row: ResolvedSnapshotImportRow): Promise<string | null> {
  try {
    await prisma.inventorySnapshot.create({ data: { ...row, source: "IMPORT" } });
    return null;
  } catch (error: unknown) {
    return `Database error: ${getErrorMessage(error, "unknown error")}`;
  }
}

type RecordOutcome =
  | { kind: "skipped" }
  | { kind: "created" }
  | { kind: "error"; sample: UnresolvedSample }
  | { kind: "unresolvedProduct"; sample: UnresolvedSample }
  | { kind: "unresolvedLocation"; sample: UnresolvedSample };

/**
 * Resolve + (attempt to) persist one CSV row, folded into a single outcome
 * the caller's loop just switches on. Isolates the "what does this row's
 * result mean for the response" branching from the request-level
 * orchestration in the handler below.
 */
async function processImportRecord(
  record: Record<string, unknown>,
  maps: SnapshotImportMaps,
): Promise<RecordOutcome> {
  const result = resolveSnapshotImportRow(record, maps);

  if (result.status === "skip") return { kind: "skipped" };

  if (result.status === "invalid") {
    return { kind: "error", sample: { data: record, message: result.message } };
  }

  if (result.status === "unresolvedProduct") {
    return {
      kind: "unresolvedProduct",
      sample: { data: record, message: `No product found with externalId ${result.externalId}.` },
    };
  }

  if (result.status === "unresolvedLocation") {
    return {
      kind: "unresolvedLocation",
      sample: {
        data: record,
        message: result.location
          ? `No StockLocation alias matches "${result.location}" -- add it to locationAliases.`
          : `Row has no Stocklocation value.`,
      },
    };
  }

  // result.status === "ok"
  const errorMessage = await persistResolvedRow(result.row);
  return errorMessage
    ? { kind: "error", sample: { data: record, message: errorMessage } }
    : { kind: "created" };
}

async function loadResolutionMaps(): Promise<SnapshotImportMaps> {
  // Preload once per chunk rather than a query per row.
  const products = await prisma.product.findMany({
    where: { externalId: { not: null } },
    select: { id: true, externalId: true },
  });
  const productByExternalId = new Map<number, number>();
  for (const p of products) {
    if (p.externalId !== null) productByExternalId.set(p.externalId, p.id);
  }

  const stockLocations = await prisma.stockLocation.findMany({
    select: { id: true, storeLocationId: true, locationAliases: true },
  });
  const locationAliasMap = new Map<string, { stockLocationId: number; storeLocationId: number }>();
  for (const sl of stockLocations) {
    for (const alias of sl.locationAliases) {
      locationAliasMap.set(alias.trim().toLowerCase(), {
        stockLocationId: sl.id,
        storeLocationId: sl.storeLocationId,
      });
    }
  }

  return { productByExternalId, locationAliasMap };
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { records } = req.body;
    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ error: "Invalid records data." });
    }

    const maps = await loadResolutionMaps();

    let createdCount = 0;
    const errors: UnresolvedSample[] = [];
    const unresolvedProducts = new SampleBucket();
    const unresolvedLocations = new SampleBucket();

    for (const record of records) {
      const outcome = await processImportRecord(record, maps);
      switch (outcome.kind) {
        case "skipped":
          break;
        case "created":
          createdCount++;
          break;
        case "error":
          errors.push(outcome.sample);
          break;
        case "unresolvedProduct":
          unresolvedProducts.record(outcome.sample);
          break;
        case "unresolvedLocation":
          unresolvedLocations.record(outcome.sample);
          break;
      }
    }

    res.status(200).json({
      createdCount,
      errors,
      errorCount: errors.length,
      unresolvedProducts: { count: unresolvedProducts.count, samples: unresolvedProducts.samples },
      unresolvedLocations: {
        count: unresolvedLocations.count,
        samples: unresolvedLocations.samples,
      },
    });
  },
);

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};
