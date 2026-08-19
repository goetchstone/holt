// /app/src/pages/api/admin/imports/run.ts
//
// Execute a saved ImportDefinition against parsed rows. This one WRITES.
//
// The counterpart to ./preview.ts and the last link in
// docs/domains/imports-configurable.md's operator flow: author a definition as
// a preset or in the admin UI, preview it against a sample, then run it. Until
// this existed a deployment could configure an import and never actually
// perform one through that configuration -- the hand-coded importers were the
// only way anything got imported, which is what makes holt one vendor's system
// rather than anyone's.
//
// Two refusals separate this from the preview, both deliberate:
//
//   INACTIVE definitions are refused. Preview deliberately allows them -- a
//   definition ships inactive while its mappings are still being worked out --
//   but `isActive` is exactly the operator's statement that a definition is
//   ready to move data. Ignoring it here would make the flag decorative.
//
//   A definition with no runnerKey is refused. runImportEngine is a PLANNER:
//   it classifies rows and writes nothing, by design. Only a registered runner
//   persists. Falling back to the engine when the caller asked to RUN would
//   report "imported: N" for rows that were never written -- worse than an
//   error, because it looks like success.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError, logger } from "@/lib/logger";
import { getImportRunner } from "@/lib/imports/runnerRegistry";
import type { RawRow } from "@/lib/imports/types";
import type { GenericImportResult } from "@/lib/genericImport";

const MAX_ROWS = 20_000;

interface RunResponse extends GenericImportResult {
  definition: { id: number; name: string; targetEntity: string; runnerKey: string };
}

// MANAGER/ADMIN, matching pages/api/import/generic.ts -- this moves the same
// data through a different door, so it takes the same gate rather than a
// config-shaped one. admin.config governs AUTHORING a definition (preview.ts
// and the presets endpoints); RUNNING one is a data import.
export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse<RunResponse | { error: string }>, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body as { definitionId?: unknown; rows?: unknown };
    const definitionId = Number(body.definitionId);
    if (!Number.isInteger(definitionId) || definitionId <= 0) {
      return res.status(400).json({ error: "definitionId must be a positive integer" });
    }
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "rows must be a non-empty array of parsed source rows" });
    }
    if (body.rows.length > MAX_ROWS) {
      // Refused, never truncated. A truncated IMPORT silently drops data and
      // reports success for the part it kept. The preview may sample because
      // it only reports; this one moves data.
      return res.status(413).json({
        error: `Too many rows (${body.rows.length}). Split the file into chunks of ${MAX_ROWS} or fewer.`,
      });
    }

    try {
      const definition = await prisma.importDefinition.findUnique({
        where: { id: definitionId },
        include: { fieldMappings: true, valueMappings: true },
      });
      if (!definition) {
        return res.status(404).json({ error: `No import definition with id ${definitionId}` });
      }
      if (!definition.isActive) {
        return res.status(409).json({
          error: `Import definition "${definition.name}" is inactive. Preview it at /api/admin/imports/preview, then activate it to run.`,
        });
      }
      if (!definition.runnerKey) {
        return res.status(409).json({
          error: `Import definition "${definition.name}" has no runnerKey, so nothing can write its rows. The engine classifies rows but never persists; a registered runner is required to import.`,
        });
      }

      const runner = getImportRunner(definition.runnerKey);
      const result = await runner({
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
        rows: body.rows as RawRow[],
        userEmail: session.user?.email ?? "unknown",
      });

      // The hand-coded import routes leave no trace of who ran one. Logged so a
      // configured import is at least as accountable as the code it replaces.
      logger.info("import definition run", {
        definitionId: definition.id,
        definitionName: definition.name,
        targetEntity: definition.targetEntity,
        runnerKey: definition.runnerKey,
        rows: body.rows.length,
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors.length,
        by: session.user?.email ?? "unknown",
      });

      return res.status(200).json({
        ...result,
        definition: {
          id: definition.id,
          name: definition.name,
          targetEntity: definition.targetEntity,
          runnerKey: definition.runnerKey,
        },
      });
    } catch (err: unknown) {
      // getImportRunner throws for an unregistered key with an operator-readable
      // message; surfaced as a 409 rather than swallowed into a generic 500.
      const message = err instanceof Error ? err.message : "Import failed";
      logError("import definition run failed", err);
      return res.status(message.includes("is not registered") ? 409 : 500).json({ error: message });
    }
  },
);
