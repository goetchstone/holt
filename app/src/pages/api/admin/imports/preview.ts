// /app/src/pages/api/admin/imports/preview.ts
//
// Dry-run a saved ImportDefinition against sample rows. Writes nothing.
//
// This is the missing step 6 of docs/domains/imports-configurable.md's "How
// someone adds a definition": author a definition as a preset or in the admin
// UI, then "run runImportEngine against a sample of parsed rows to preview
// would-create/would-update/skipped/error before committing anything."
//
// Until now there was no way to do that. The engine was written as the dry run
// -- it performs no I/O and returns a preview by construction -- and had zero
// callers, so an operator could configure a mapping and had no way to find out
// whether it worked short of running a real import. That is the gap between
// "holt is configurable" and "someone other than its author can configure it".
//
// Deliberately read-only. The commit path is a separate endpoint with a
// separate decision to make; a preview that can write is not a preview.
//
// `existingNaturalKeys` is NOT supplied here, so every valid UPSERT/RECONCILE
// row previews as `would-create`. The engine's own doc calls this out: knowing
// create-vs-update needs a Prisma query the caller owns. Answering "do my
// mappings work" does not need it, and querying the target table for a preview
// would make a read-only endpoint touch data it has no reason to.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { runImportEngine } from "@/lib/imports/engine";
import type { EngineRunResult, ImportMode, RawRow } from "@/lib/imports/types";

/** Cap on previewed rows. A preview answers "do my mappings work", which a
 *  sample answers as well as a whole file, and this keeps one pasted export
 *  from becoming a memory incident. */
const MAX_PREVIEW_ROWS = 500;

interface PreviewResponse extends EngineRunResult {
  definition: {
    id: number;
    name: string;
    targetEntity: string;
    importMode: ImportMode;
    runnerKey: string | null;
    isActive: boolean;
  };
  /** True when rows were truncated to MAX_PREVIEW_ROWS. Stated rather than
   *  silently applied — a summary over a truncated sample that looks like a
   *  summary over the file is exactly the kind of quiet wrongness this
   *  codebase keeps finding. */
  truncated: boolean;
}

export default requirePermission(
  "admin.config",
  async (req: NextApiRequest, res: NextApiResponse<PreviewResponse | { error: string }>) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body as { definitionId?: unknown; rows?: unknown };
    const definitionId = Number(body.definitionId);
    if (!Number.isInteger(definitionId) || definitionId <= 0) {
      return res.status(400).json({ error: "definitionId must be a positive integer" });
    }
    if (!Array.isArray(body.rows)) {
      return res.status(400).json({ error: "rows must be an array of parsed source rows" });
    }

    try {
      const definition = await prisma.importDefinition.findUnique({
        where: { id: definitionId },
        include: { fieldMappings: true, valueMappings: true },
      });
      if (!definition) {
        return res.status(404).json({ error: `No import definition with id ${definitionId}` });
      }

      const rows = body.rows.slice(0, MAX_PREVIEW_ROWS) as RawRow[];

      // An INACTIVE definition previews the same as an active one, on purpose.
      // A definition ships inactive precisely while its mappings are still
      // being worked out -- config/presets/ordorite-payment-modes.yaml is the
      // motivating case -- so refusing to preview it would withhold the tool
      // exactly when it is most needed.
      const result = runImportEngine({
        importMode: definition.importMode as ImportMode,
        naturalKeyFields: definition.naturalKeyFields ?? [],
        fieldMappings: definition.fieldMappings.map((f) => ({
          sourceColumn: f.sourceColumn,
          targetField: f.targetField,
          transform: f.transform as never,
          required: f.required,
          sortOrder: f.sortOrder,
        })),
        valueMappings: definition.valueMappings.map((v) => ({
          targetField: v.targetField,
          sourceValue: v.sourceValue,
          targetValue: v.targetValue,
        })),
        rows,
      });

      return res.status(200).json({
        ...result,
        definition: {
          id: definition.id,
          name: definition.name,
          targetEntity: definition.targetEntity,
          importMode: definition.importMode as ImportMode,
          runnerKey: definition.runnerKey,
          isActive: definition.isActive,
        },
        truncated: body.rows.length > MAX_PREVIEW_ROWS,
      });
    } catch (err: unknown) {
      logError("import definition preview failed", err);
      return res.status(500).json({ error: "Preview failed" });
    }
  },
);
