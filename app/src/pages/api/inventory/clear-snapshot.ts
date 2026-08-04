// /app/src/pages/api/inventory/clear-snapshot.ts
//
// Clears the physical-count baseline in InventorySnapshot.
//
// Scoped by `source`, and that scoping is the whole point of this file.
// InventorySnapshot used to have a single writer -- the POS CSV importer --
// so "clear everything" and "clear what I am about to replace" were the same
// statement, and the POS import page calls this before every upload. Once
// generating the baseline from holt's own InventoryPosition became the normal
// path (see lib/inventory/snapshot.ts), an unscoped deleteMany turned that
// pre-upload clear into a destructive act on data the importer does not own:
// upload a POS file, lose the locally-generated snapshot, and the count is
// silently measured against whatever the POS happened to know.
//
// POST { source?: "LOCAL" | "IMPORT" }
//   omitted -> clears everything (the explicit, deliberate "start over")
//   "IMPORT" -> what the POS import page sends before an upload
//   "LOCAL"  -> clears a generated baseline without touching an imported one
//
// Returns the deleted count so the caller can tell "cleared 40k rows" from
// "cleared nothing", which the previous fixed success message could not.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { auditLog } from "@/lib/audit";
import { logError, logger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

const SNAPSHOT_SOURCES = ["LOCAL", "IMPORT"] as const;
type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

function parseSource(value: unknown): SnapshotSource | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && (SNAPSHOT_SOURCES as readonly string[]).includes(value)) {
    return value as SnapshotSource;
  }
  return undefined; // present but not a valid source -> reject rather than guess
}

/** Exported for integration tests, which call it directly against the real
 *  Prisma client with a fake req/res + session — requireAuthWithRole needs
 *  real cookies. Role enforcement is covered by __tests__/roleDecision.test.ts.
 *  Same pattern as snapshot/generate.ts. */
export async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const source = parseSource((req.body ?? {}).source);
  if (source === undefined) {
    return res.status(400).json({
      error: `source must be one of ${SNAPSHOT_SOURCES.join(", ")}, or omitted to clear all`,
    });
  }

  try {
    // Explicit equals rather than a `not:` on the other value -- `source` is
    // non-nullable here, but rule 51's habit is worth keeping: a nullable
    // column plus a naked `not:` silently drops NULL rows under three-valued
    // logic, and this filter is one schema change away from being nullable.
    const where: Prisma.InventorySnapshotWhereInput = source ? { source } : {};
    const { count } = await prisma.inventorySnapshot.deleteMany({ where });

    const scope = source ?? "ALL";
    logger.info("Cleared inventory snapshot", { scope, deleted: count });
    // Destroys the baseline a physical count is judged against, so it belongs
    // in the audit stream alongside generation.
    auditLog("INVENTORY_SNAPSHOT_CLEAR", session.user?.email || "unknown", {
      scope,
      deleted: count,
    });

    const label = scope === "ALL" ? "" : `${scope} `;
    const plural = count === 1 ? "" : "s";
    const message =
      count === 0
        ? `No ${label}snapshot rows to clear.`
        : `Cleared ${count} ${label}snapshot row${plural}.`;

    return res.status(200).json({ message, deleted: count, scope });
  } catch (error: unknown) {
    logError("Failed to clear inventory snapshot", error, { source });
    return res
      .status(500)
      .json({ error: `Failed to clear data: ${getErrorMessage(error, "unknown error")}` });
  }
}

export default requireAuthWithRole(["ADMIN"], handlePost);
