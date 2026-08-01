// /app/src/lib/imports/runners/adaptColumnMapping.ts
//
// Shared by every runner that delegates to the legacy genericImportRunner.ts
// path: converts a definition's field mappings into the ColumnMapping shape
// (Record<targetField, sourceColumn | null>) that runGenericImport expects.

import type { ColumnMapping } from "@/lib/genericImport";
import type { ImportRunnerContext } from "@/lib/imports/types";

export function toColumnMapping(
  fieldMappings: ImportRunnerContext["fieldMappings"],
): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const fm of fieldMappings) {
    mapping[fm.targetField] = fm.sourceColumn || null;
  }
  return mapping;
}
