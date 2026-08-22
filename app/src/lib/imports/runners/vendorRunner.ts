// /app/src/lib/imports/runners/vendorRunner.ts
//
// Registers the vendor import under the runnerKey "vendor", the same adapter
// shape as customerRunner/productRunner/departmentRunner: turn the definition's
// field mappings into the ColumnMapping runGenericImport already expects, and
// delegate. No behaviour of its own.
//
// The writer is shared with the fixed-shape REST route, so both doors import
// vendors identically -- the point of the seam, not an accident of it.

import { runGenericImport } from "@/lib/genericImportRunner";
import type { GenericImportResult } from "@/lib/genericImport";
import type { ImportRunnerContext } from "@/lib/imports/types";
import { toColumnMapping } from "@/lib/imports/runners/adaptColumnMapping";

export async function runVendorRunner(ctx: ImportRunnerContext): Promise<GenericImportResult> {
  return runGenericImport("vendor", toColumnMapping(ctx.fieldMappings), ctx.rows, ctx.userEmail);
}
