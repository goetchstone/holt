// /app/src/lib/imports/types.ts
//
// Client/server-safe contract for the configurable import engine. Mirrors
// the intent of genericImport.ts (rule 7: shared client/server contracts
// live in one file) but scoped to the pieces added in Stage 1: the pure
// execution engine, the runner registry, and definition validation. No
// Prisma import here — the literal string unions below mirror the
// ImportMode / ImportTransform enums in prisma/schema.prisma; keep them in
// sync by hand when either changes.
//
// This file intentionally does NOT redefine ImportEntityDef / ImportFieldDef
// — those stay owned by genericImport.ts. An ImportDefinition's
// `targetEntity` is a string key into IMPORT_ENTITIES there.

import type { GenericImportResult } from "@/lib/genericImport";

/**
 * INSERT_ONLY / UPSERT -- the source is a delta or one-time dump; every row
 * is a fact to insert or upsert. Fully engine-driven, no runnerKey required.
 *
 * RECONCILE -- the source is a full-state re-export (e.g. Ordorite: every
 * file asserts "this is everything as of now"). The importer must diff
 * against existing data — dropped lines, rewrites, zero-qty-means-cancelled
 * — which is inherently code. RECONCILE definitions MUST name a registered
 * runnerKey (enforced by validateImportDefinition and the
 * ImportDefinition_reconcile_requires_runner DB constraint).
 */
export type ImportMode = "INSERT_ONLY" | "UPSERT" | "RECONCILE";

/**
 * The fixed, small transform set (lib/imports/transforms.ts has the
 * justification for each). Deliberately not extensible into a DSL.
 */
export type ImportTransformKey =
  "TRIM" | "UPPERCASE" | "LOWERCASE" | "NUMBER" | "DATE" | "CURRENCY";

/** One row of an ImportFieldMapping table, as the engine needs it. */
export interface FieldMappingInput {
  sourceColumn: string;
  targetField: string;
  transform?: ImportTransformKey | null;
  required?: boolean;
  sortOrder?: number;
}

/** One row of an ImportValueMapping table, as the engine needs it. */
export interface ValueMappingInput {
  targetField: string;
  sourceValue: string;
  targetValue: string;
}

/** The subset of ImportDefinition the engine needs to classify rows. */
export interface ImportDefinitionInput {
  importMode: ImportMode;
  naturalKeyFields?: string[];
  runnerKey?: string | null;
}

export type NormalizedValue = string | number | undefined;
export type NormalizedRecord = Record<string, NormalizedValue>;

export type RowOutcomeKind = "would-create" | "would-update" | "skipped" | "error";

export interface RowOutcome {
  /** 0-based index into the input rows array (row 1 in operator-facing UI). */
  index: number;
  outcome: RowOutcomeKind;
  record: NormalizedRecord;
  /** Present only when the definition has natural key fields and every
   *  component resolved to a non-empty value. */
  naturalKey?: string;
  errors: string[];
}

export interface UnmappedValueSummary {
  targetField: string;
  sourceValue: string;
  count: number;
  /** 0-based row indexes where this unmapped value was encountered, capped
   *  at 20 so one wildly-dirty column doesn't blow up the preview payload. */
  rowIndexes: number[];
}

export interface EngineRunSummary {
  total: number;
  wouldCreate: number;
  wouldUpdate: number;
  skipped: number;
  errors: number;
}

export interface EngineRunResult {
  rows: RowOutcome[];
  unmappedValues: UnmappedValueSummary[];
  summary: EngineRunSummary;
}

/** One parsed source row — a CSV/XLSX row keyed by header, before any
 *  mapping is applied. Matches genericImportRunner.ts's RawRow shape. */
export type RawRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The code-backed escape hatch (lib/imports/runnerRegistry.ts)
// ---------------------------------------------------------------------------

/** What a registered runner receives: the definition's mappings plus the
 *  parsed rows. The runner owns row processing end to end and returns the
 *  same result shape every import path already returns. */
export interface ImportRunnerContext {
  fieldMappings: FieldMappingInput[];
  valueMappings: ValueMappingInput[];
  rows: RawRow[];
  userEmail: string;
}

// A runner returns the same result shape every import path already returns
// (genericImport.ts's GenericImportResult) — one source of truth, no
// parallel result type.
export type ImportRunner = (ctx: ImportRunnerContext) => Promise<GenericImportResult>;
