// /app/src/lib/imports/runners/departmentRunner.ts
//
// Registers the department import under the runnerKey "department", the same
// adapter shape as customerRunner/productRunner: convert the definition's
// field mappings into the ColumnMapping runGenericImport already expects, and
// delegate. No behaviour of its own.
//
// This is the first entity added to the configurable path since the seam was
// built, so it is also the proof that adding one is small: an entity in
// IMPORT_ENTITIES, a writer in genericImportRunner.ts, and this file. The
// writer is shared with the fixed-shape REST route, so both doors import
// departments identically.
//
// Value mappings do not apply here — a department name is free text with no
// bounded target vocabulary to translate into.

import { runGenericImport } from "@/lib/genericImportRunner";
import type { GenericImportResult } from "@/lib/genericImport";
import type { ImportRunnerContext } from "@/lib/imports/types";
import { toColumnMapping } from "@/lib/imports/runners/adaptColumnMapping";

export async function runDepartmentRunner(ctx: ImportRunnerContext): Promise<GenericImportResult> {
  return runGenericImport(
    "department",
    toColumnMapping(ctx.fieldMappings),
    ctx.rows,
    ctx.userEmail,
  );
}
