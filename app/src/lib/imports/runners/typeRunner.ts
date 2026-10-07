// /app/src/lib/imports/runners/typeRunner.ts
//
// Registers the type import under the runnerKey "type" — the same thin adapter
// shape as the other runners: turn the definition's field mappings into the
// ColumnMapping runGenericImport expects, and delegate. No behaviour of its own.
//
// The writer is shared with the fixed-shape REST route, so both doors import
// types identically — including the refusal to invent a category that does not
// exist.

import { runGenericImport } from "@/lib/genericImportRunner";
import type { GenericImportResult } from "@/lib/genericImport";
import type { ImportRunnerContext } from "@/lib/imports/types";
import { toColumnMapping } from "@/lib/imports/runners/adaptColumnMapping";

export async function runTypeRunner(ctx: ImportRunnerContext): Promise<GenericImportResult> {
  return runGenericImport("type", toColumnMapping(ctx.fieldMappings), ctx.rows, ctx.userEmail);
}
