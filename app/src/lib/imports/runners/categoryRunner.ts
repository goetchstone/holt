// /app/src/lib/imports/runners/categoryRunner.ts
//
// Registers the category import under the runnerKey "category" — the same thin
// adapter shape as the other runners: turn the definition's field mappings into
// the ColumnMapping runGenericImport expects, and delegate. No behaviour of its
// own.
//
// The writer is shared with the fixed-shape REST route, so both doors import
// categories identically.

import { runGenericImport } from "@/lib/genericImportRunner";
import type { GenericImportResult } from "@/lib/genericImport";
import type { ImportRunnerContext } from "@/lib/imports/types";
import { toColumnMapping } from "@/lib/imports/runners/adaptColumnMapping";

export async function runCategoryRunner(ctx: ImportRunnerContext): Promise<GenericImportResult> {
  return runGenericImport("category", toColumnMapping(ctx.fieldMappings), ctx.rows, ctx.userEmail);
}
