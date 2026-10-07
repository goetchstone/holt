// /app/src/lib/imports/engine.ts
//
// Pure execution engine for configurable imports. No Prisma, no fs, no I/O
// — given a definition's field/value mappings and a batch of parsed rows,
// it produces normalized records plus a per-row outcome. Deterministic and
// fully unit-testable (same inputs always produce the same outputs).
//
// This function IS the dry-run / preview: it never writes anything, so
// calling it against a sample of rows gives the exact would-create /
// would-update / skipped / error breakdown an operator would see before an
// import actually runs. A caller that wants to commit an INSERT_ONLY /
// UPSERT definition turns `outcome.record` into a Prisma write per row; a
// caller with a `runnerKey` hands the definition's mappings to the
// registered runner instead (lib/imports/runnerRegistry.ts) and this
// function's classification becomes a best-effort mapping-level preview —
// the runner may still create/update/cancel differently once it reconciles
// against existing data. See docs/domains/imports-configurable.md.
//
// Order of operations per field, per row (fixed — this is the whole
// contract):
//   1. field mapping  — pick the raw source column value off the row
//   2. value mapping   — translate a raw source value onto the target's
//                        bounded vocabulary, IF this field has any value
//                        mappings configured. A value present in the file
//                        but absent from the configured set is a REPORTED
//                        error, never a silent pass-through — that is the
//                        exact failure mode this engine exists to remove
//                        (see the "Card Connect" case in the runbook).
//   3. transform        — trim/case/number/date/currency coercion
//   4. required check   — once per row, after all fields are resolved
//
// A row where every mapped source column is blank is classified `skipped`
// (trailing blank CSV lines, etc.) rather than piling up "N required
// fields missing" errors for a row that was never meant to carry data.

import type {
  EngineRunResult,
  EngineRunSummary,
  FieldMappingInput,
  ImportMode,
  NormalizedRecord,
  RawRow,
  RowOutcome,
  RowOutcomeKind,
  UnmappedValueSummary,
  ValueMappingInput,
} from "@/lib/imports/types";
import { applyTransform } from "@/lib/imports/transforms";

const MAX_UNMAPPED_ROW_INDEXES = 20;

export interface RunImportEngineOptions {
  importMode: ImportMode;
  /** Target field keys that identify an existing record for UPSERT/
   *  RECONCILE matching. Ignored for INSERT_ONLY. */
  naturalKeyFields?: string[];
  fieldMappings: FieldMappingInput[];
  valueMappings: ValueMappingInput[];
  rows: RawRow[];
  /** Natural keys already present in the target table, joined the same way
   *  computeNaturalKey joins them, supplied by the caller after querying
   *  Prisma. Omit to classify every UPSERT/RECONCILE row as would-create
   *  (e.g. a preview with no DB round trip yet). */
  existingNaturalKeys?: ReadonlySet<string>;
}

/** Stringify a raw cell value the same way every mapped field starts out:
 *  null/undefined/blank become undefined, everything else is trimmed to a
 *  string. Deliberately simpler than importHelpers.safeString, which also
 *  treats a bare "@" as empty — that's an Ordorite-specific placeholder
 *  convention, not a generic-CSV one, and doesn't belong in a source-
 *  agnostic engine. */
function rawToString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** Join natural-key field values into one comparable string.
 *  JSON-encoding the ordered part list (rather than a plain delimiter join)
 *  sidesteps any collision between e.g. ["A", "B,C"] and ["A,B", "C"]. */
export function computeNaturalKey(
  naturalKeyFields: string[],
  record: NormalizedRecord,
): { key: string } | { missingField: string } {
  const parts: string[] = [];
  for (const field of naturalKeyFields) {
    const value = record[field];
    if (value === undefined || value === "") return { missingField: field };
    parts.push(String(value));
  }
  return { key: JSON.stringify(parts) };
}

/** Field-mapping + value-mapping + transform for one row. Returns the
 *  normalized record, any errors encountered, and whether at least one
 *  mapped column had a value (used to distinguish a genuinely blank row
 *  from one with real validation problems). */
function mapRow(
  row: RawRow,
  orderedFields: FieldMappingInput[],
  valueMapsByField: Map<string, Map<string, string>>,
  onUnmapped: (targetField: string, sourceValue: string) => void,
): { record: NormalizedRecord; errors: string[]; anyNonEmpty: boolean } {
  const errors: string[] = [];
  const record: NormalizedRecord = {};
  let anyNonEmpty = false;

  for (const fm of orderedFields) {
    const rawStr = rawToString(row[fm.sourceColumn]);
    if (rawStr === undefined) continue;
    anyNonEmpty = true;

    let value: string | number = rawStr;

    const valueMap = valueMapsByField.get(fm.targetField);
    if (valueMap) {
      const mapped = valueMap.get(rawStr);
      if (mapped === undefined) {
        errors.push(`Unmapped value "${rawStr}" for field "${fm.targetField}"`);
        onUnmapped(fm.targetField, rawStr);
        continue; // do not let the untranslated raw value pass through
      }
      value = mapped;
    }

    if (fm.transform) {
      const result = applyTransform(fm.transform, String(value));
      if (result.error) {
        errors.push(`Field "${fm.targetField}": ${result.error}`);
        continue;
      }
      value = result.value!;
    }

    record[fm.targetField] = value;
  }

  return { record, errors, anyNonEmpty };
}

function checkRequiredFields(
  orderedFields: FieldMappingInput[],
  record: NormalizedRecord,
): string[] {
  const errors: string[] = [];
  for (const fm of orderedFields) {
    if (!fm.required) continue;
    const value = record[fm.targetField];
    if (value === undefined || value === "") {
      errors.push(`Missing required field "${fm.targetField}"`);
    }
  }
  return errors;
}

function classifyMode(
  importMode: ImportMode,
  naturalKeyFields: string[] | undefined,
  record: NormalizedRecord,
  existingNaturalKeys: ReadonlySet<string> | undefined,
  errors: string[],
): { outcome: RowOutcomeKind; naturalKey?: string } {
  if (importMode === "INSERT_ONLY" || !naturalKeyFields || naturalKeyFields.length === 0) {
    return { outcome: "would-create" };
  }

  const keyResult = computeNaturalKey(naturalKeyFields, record);
  if ("missingField" in keyResult) {
    errors.push(`Cannot compute natural key: field "${keyResult.missingField}" is empty`);
    return { outcome: "error" };
  }

  const exists = existingNaturalKeys?.has(keyResult.key) ?? false;
  return { outcome: exists ? "would-update" : "would-create", naturalKey: keyResult.key };
}

export function runImportEngine(options: RunImportEngineOptions): EngineRunResult {
  const { importMode, naturalKeyFields, fieldMappings, valueMappings, rows, existingNaturalKeys } =
    options;

  const orderedFields = [...fieldMappings].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  // targetField -> (sourceValue -> targetValue)
  const valueMapsByField = new Map<string, Map<string, string>>();
  for (const vm of valueMappings) {
    let inner = valueMapsByField.get(vm.targetField);
    if (!inner) {
      inner = new Map();
      valueMapsByField.set(vm.targetField, inner);
    }
    inner.set(vm.sourceValue, vm.targetValue);
  }

  // JSON.stringify([targetField, sourceValue]) -> summary accumulator
  const unmappedByKey = new Map<string, UnmappedValueSummary>();
  function recordUnmapped(targetField: string, sourceValue: string, rowIndex: number): void {
    const key = JSON.stringify([targetField, sourceValue]);
    let entry = unmappedByKey.get(key);
    if (!entry) {
      entry = { targetField, sourceValue, count: 0, rowIndexes: [] };
      unmappedByKey.set(key, entry);
    }
    entry.count++;
    if (entry.rowIndexes.length < MAX_UNMAPPED_ROW_INDEXES) entry.rowIndexes.push(rowIndex);
  }

  const rowOutcomes: RowOutcome[] = rows.map((row, index) => {
    const { record, errors, anyNonEmpty } = mapRow(
      row,
      orderedFields,
      valueMapsByField,
      (field, val) => recordUnmapped(field, val, index),
    );

    if (!anyNonEmpty) {
      return { index, outcome: "skipped", record, errors: [] };
    }

    errors.push(...checkRequiredFields(orderedFields, record));

    if (errors.length > 0) {
      return { index, outcome: "error", record, errors };
    }

    const { outcome, naturalKey } = classifyMode(
      importMode,
      naturalKeyFields,
      record,
      existingNaturalKeys,
      errors,
    );
    return { index, outcome, record, naturalKey, errors };
  });

  const summary: EngineRunSummary = {
    total: rowOutcomes.length,
    wouldCreate: 0,
    wouldUpdate: 0,
    skipped: 0,
    errors: 0,
  };
  for (const r of rowOutcomes) {
    if (r.outcome === "would-create") summary.wouldCreate++;
    else if (r.outcome === "would-update") summary.wouldUpdate++;
    else if (r.outcome === "skipped") summary.skipped++;
    else summary.errors++;
  }

  const unmappedValues = Array.from(unmappedByKey.values()).sort(
    (a, b) =>
      a.targetField.localeCompare(b.targetField) || a.sourceValue.localeCompare(b.sourceValue),
  );

  return { rows: rowOutcomes, unmappedValues, summary };
}
