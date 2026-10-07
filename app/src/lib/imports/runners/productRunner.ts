// /app/src/lib/imports/runners/productRunner.ts
//
// Registers the EXISTING product import path (lib/genericImportRunner.ts)
// under the runnerKey "product". Sibling of customerRunner.ts -- see that
// file's header for the full rationale (why UPSERT-mode entities can still
// carry a runnerKey, and why value mappings aren't applied here).
//
// importProducts' vendor/department/category auto-create-with-cache logic
// and "Unknown Vendor" / "Uncategorized" placeholder defaults are exactly
// the kind of write-side behavior that's cheaper to reuse through the
// escape hatch than to reimplement as pure config right now.

import { runGenericImport } from "@/lib/genericImportRunner";
import type { GenericImportResult } from "@/lib/genericImport";
import type { ImportRunnerContext } from "@/lib/imports/types";
import { toColumnMapping } from "@/lib/imports/runners/adaptColumnMapping";

export async function runProductRunner(ctx: ImportRunnerContext): Promise<GenericImportResult> {
  return runGenericImport("product", toColumnMapping(ctx.fieldMappings), ctx.rows, ctx.userEmail);
}
