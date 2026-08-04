// /app/src/lib/config/presetApiTypes.ts
//
// Client/server contract for the Admin > Settings > Configuration API
// (pages/api/admin/config/**). Isomorphic — no `fs`, no Prisma — so the
// admin GUI's "use client" panels import these same interfaces the API
// routes respond with, rather than each panel re-declaring an ad hoc fetch
// response shape that quietly drifts from what the server actually sends.
// Same rule 7 (shared client/server contracts live in one file) that
// presetSchema.ts and presetSerialize.ts already follow.
//
// Two shapes here deliberately MIRROR server-only types instead of
// importing them, so this file stays safe to pull into a client bundle:
//   - ApplyResultSummary mirrors ApplyResult from lib/config/applyPreset.ts
//     (which imports Prisma).
//   - DiskReport mirrors PresetLoadReport from lib/config/presetFiles.ts
//     (which imports `node:fs`).
// If either server-side shape changes, update the mirror here too.

import type { PresetBundle, PresetKind } from "@/lib/config/presetSchema";
import type { PresetFormat } from "@/lib/config/presetSerialize";

// ---------------------------------------------------------------------------
// GET /api/admin/config/presets
// ---------------------------------------------------------------------------

/** Just enough of StoreLocation for the traffic-store-mapping editor. Not
 *  the same as a "traffic-store-mapping" preset entry — this list includes
 *  EVERY store, including ones with zero mapped names, because an operator
 *  has to be able to add the first mapping to a store, not just edit an
 *  existing one. (A preset's `stores` array only lists stores that already
 *  have at least one sourceName — the schema requires sourceNames.min(1)
 *  per entry.) */
export interface StoreLocationSummary {
  id: number;
  name: string;
  isActive: boolean;
  trafficSourceNames: string[];
}

export interface DiskPresetError {
  sourceFile: string;
  messages: string[];
}

export interface DiskPresetOverride {
  kind: string;
  name: string;
  shippedFile: string;
  localFile: string;
}

/** Mirrors PresetLoadReport minus its `presets` field — the GUI only needs
 *  to know WHETHER something on disk would shadow or fail to load, not the
 *  parsed content (the DB is the source of truth for what the GUI shows). */
export interface DiskReport {
  errors: DiskPresetError[];
  overrides: DiskPresetOverride[];
}

export interface PresetsGetResponse {
  bundle: PresetBundle;
  storeLocations: StoreLocationSummary[];
  /** Distinct TrafficSnapshot.axperStoreName values with no owning
   *  StoreLocation — one-click "assign to store" suggestions. */
  unmappedTrafficSourceNames: string[];
  diskReport: DiskReport;
}

// ---------------------------------------------------------------------------
// POST /api/admin/config/presets/validate
// ---------------------------------------------------------------------------

export interface ValidateRequestBody {
  text: string;
  format?: PresetFormat;
}

/** Same shape as PresetParseResult (presetSchema.ts) — re-declared as a
 *  plain discriminated union here rather than imported so this file has one
 *  import source (presetSchema's TYPES only) and the response contract is
 *  readable without following another file. */
export type ValidateResponse = { ok: true; bundle: PresetBundle } | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// POST /api/admin/config/presets/apply
// ---------------------------------------------------------------------------

export interface ApplyChangeCounts {
  created: number;
  updated: number;
  deleted: number;
}

export type ApplyAction = "APPLIED" | "UNCHANGED" | "FAILED";

/** Mirrors applyPreset.ts's ApplyResult — see file header for why this is a
 *  duplicate rather than an import. */
export interface ApplyResultSummary {
  kind: PresetKind;
  name: string;
  action: ApplyAction;
  changes: ApplyChangeCounts;
  messages: string[];
}

export interface ApplyRequestBody {
  bundle: PresetBundle;
  /** Omitted or true means "compute and report the diff, write nothing" —
   *  dry run is the safe default the API itself enforces, not just a UI
   *  convention. Pass `false` explicitly to actually write. */
  dryRun?: boolean;
}

export interface ApplyResponse {
  results: ApplyResultSummary[];
}

// ---------------------------------------------------------------------------
// GET /api/admin/config/changes
// ---------------------------------------------------------------------------

export interface ConfigChangeLogRow {
  id: number;
  presetKind: string;
  presetName: string;
  action: string;
  source: string;
  /** ConfigChangeLog.summary — counts plus what moved, never the whole
   *  preset. Untyped JSON on purpose (see the Prisma model comment); the
   *  history panel renders it defensively. */
  summary: unknown;
  actor: string | null;
  /** ISO 8601 — Dates don't survive JSON.stringify as Date objects. */
  created: string;
}

export interface ChangesResponse {
  changes: ConfigChangeLogRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The traffic-store-mapping preset name the GUI reads and writes under.
 *  StoreLocation.trafficSourceNames carries no record of which named preset
 *  last claimed it — the DB is flat, only ConfigChangeLog has a `name` at
 *  all, and only for the deletion bookkeeping applyPreset.ts does internally.
 *  So the GUI has to pick ONE stable identity to operate under rather than
 *  inventing a name per edit. "traffic-stores" matches the name both
 *  config/presets/traffic-stores.yaml and config/local/saybrook.yaml already
 *  use, which is the common case: a deployment overrides the shipped preset
 *  by reusing its name. A deployment whose local file uses a DIFFERENT name
 *  will have its store rows edited correctly by the GUI (the underlying
 *  StoreLocation writes are the same either way) but the GUI's edits land
 *  under a separate (kind, name) identity in ConfigChangeLog, so its own
 *  "clear a store this preset no longer claims" bookkeeping only tracks
 *  what the GUI itself has applied, not what a differently-named CLI preset
 *  claimed. Worth knowing if a deployment's local override uses a custom
 *  name; most don't. */
export const TRAFFIC_STORE_MAPPING_PRESET_NAME = "traffic-stores";
