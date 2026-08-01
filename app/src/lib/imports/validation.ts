// /app/src/lib/imports/validation.ts
//
// Structural validation for an ImportDefinition, independent of any
// particular row of data. Meant to run before a definition is written (the
// Stage 2 admin UI's save path) and exercised directly by tests here. Pure
// -- no Prisma, no I/O.
//
// Rule 1 below is ALSO enforced at the DB layer -- the
// ImportDefinition_reconcile_requires_runner CHECK constraint added in the
// Stage 1 migration is the structural backstop (mirrors the
// JournalEntry_balanced_check precedent: the app layer gives a friendly
// error, the DB constraint means a raw write or a future bug can't bypass
// it). This function is the friendly, pre-flight half of that pair.

import type { ImportDefinitionInput } from "@/lib/imports/types";

export function validateImportDefinition(def: ImportDefinitionInput): string[] {
  const errors: string[] = [];

  // RECONCILE sources are full-state re-exports that must diff against
  // existing data (dropped lines, rewrites, zero-qty-means-cancelled) --
  // inherently code, so a registered runner MUST own row processing.
  if (def.importMode === "RECONCILE" && !def.runnerKey?.trim()) {
    errors.push(
      'importMode "RECONCILE" requires a runnerKey — reconciliation cannot be pure config.',
    );
  }

  // UPSERT needs a natural key to tell "would-update" from "would-create".
  // INSERT_ONLY has no such need (every row is a create); RECONCILE's
  // matching is owned by its runner, so a natural key there is optional
  // documentation, not a requirement.
  if (def.importMode === "UPSERT" && (!def.naturalKeyFields || def.naturalKeyFields.length === 0)) {
    errors.push('importMode "UPSERT" requires at least one naturalKeyFields entry.');
  }

  return errors;
}

export function isValidImportDefinition(def: ImportDefinitionInput): boolean {
  return validateImportDefinition(def).length === 0;
}
