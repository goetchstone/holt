// /app/src/lib/config/applyPreset.ts
//
// Server-only: turns a validated Preset (presetSchema.ts) into database rows,
// idempotently, with a durable audit trail. This is the application layer
// both doors share — the GitOps CLI (scripts/apply-preset.mjs) and the admin
// GUI's save path both call applyPreset()/applyBundle() and get the same
// diffing, the same reconciliation, and the same ConfigChangeLog row.
//
// THE HEADLINE PROPERTY IS IDEMPOTENCY. A preset is a desired-state
// declaration, not an append: applying it twice must write nothing the
// second time, and deleting a line from the file then re-applying must
// delete the corresponding row. Every code path below computes the full
// diff BEFORE touching the database and skips the write entirely when
// nothing differs — that's what makes `action: "UNCHANGED"` mean "zero
// writes," not just "no error."
//
// Two validations happen here rather than in presetSchema.ts, on purpose
// (see the schema file's comment on targetEntity/runnerKey): they need the
// server-side entity catalog and runner registry, which the isomorphic
// schema file cannot import.
//
//   - targetEntity unknown to IMPORT_ENTITIES (lib/genericImport.ts): NOT a
//     failure. The definition is still saved, but isActive is forced to
//     false regardless of what the preset asked for, and the reason is
//     recorded in the result and the ConfigChangeLog summary. This mirrors
//     prisma/seed/ordoritePaymentMode.ts, which seeds a targetEntity:
//     "payment" definition (isActive: false) as a shape proof for an entity
//     that does not exist yet — a preset naming a not-yet-built entity is
//     useful as documented intent, not an error to reject.
//   - runnerKey unknown to the runner registry (lib/imports/runnerRegistry.ts):
//     IS a hard failure. A runnerKey names executable behaviour; silently
//     accepting an unresolvable one would let a RECONCILE definition look
//     configured while running nothing at all. Different risk from an
//     inactive-but-saved definition, so a different answer.

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma, TX_TIMEOUT } from "@/lib/prisma";
import { auditLog } from "@/lib/audit";
import { logError, logger } from "@/lib/logger";
import { getImportEntity, IMPORT_ENTITIES } from "@/lib/genericImport";
import { isRegisteredRunnerKey, listRegisteredRunnerKeys } from "@/lib/imports/runnerRegistry";
import type { FieldMappingInput, ValueMappingInput } from "@/lib/imports/types";
import {
  flattenValueMappings,
  type ImportDefinitionPreset,
  type Preset,
  type PresetBundle,
  type PresetKind,
  type TrafficStoreMappingPreset,
} from "@/lib/config/presetSchema";
import { invalidateTrafficStoreMap } from "@/lib/trafficStoreMap";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ApplyPresetOpts {
  /** Where this apply came from, e.g. "cli:config/local/saybrook.yaml" or
   *  "gui". Stored verbatim on ConfigChangeLog.source. */
  source: string;
  /** Operator email, or null/undefined for an unattended run. */
  actor?: string | null;
  /** Compute and report the full diff; write nothing — not even the
   *  ConfigChangeLog row. */
  dryRun?: boolean;
  /** Injectable for tests. Defaults to the shared `@/lib/prisma` client. */
  prisma?: PrismaClient;
}

export interface ApplyChangeCounts {
  created: number;
  updated: number;
  deleted: number;
}

export type ApplyAction = "APPLIED" | "UNCHANGED" | "FAILED";

export interface ApplyResult {
  kind: PresetKind;
  name: string;
  action: ApplyAction;
  changes: ApplyChangeCounts;
  /** Human-readable, one line per row that changed (or per reason it
   *  failed) — a compact "what happened," not the preset content. */
  messages: string[];
}

export async function applyPreset(preset: Preset, opts: ApplyPresetOpts): Promise<ApplyResult> {
  const db = opts.prisma ?? defaultPrisma;
  let outcome: KindOutcome;
  try {
    outcome =
      preset.kind === "import-definition"
        ? await applyImportDefinition(db, preset, opts)
        : await applyTrafficStoreMapping(db, preset, opts);
  } catch (err) {
    logError(`applyPreset: unexpected error applying ${preset.kind}/${preset.name}`, err, {
      presetKind: preset.kind,
      presetName: preset.name,
      source: opts.source,
    });
    outcome = failOutcome(preset, [
      `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  return recordApply(db, preset, opts, outcome);
}

/** Apply every preset in a bundle, in file order. Sequential (not
 *  Promise.all) so log output and ConfigChangeLog rows land in a
 *  predictable order and one preset's transaction never overlaps another's. */
export async function applyBundle(
  bundle: PresetBundle,
  opts: ApplyPresetOpts,
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const preset of bundle.presets) {
    results.push(await applyPreset(preset, opts));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/** What a kind-specific apply function produces: the public result, plus the
 *  (possibly larger, but still compact) data that goes into
 *  ConfigChangeLog.summary. Kept separate from ApplyResult because the
 *  summary needs a little more than the result does — e.g. traffic-store-
 *  mapping needs to persist which stores it owns so the NEXT apply can tell
 *  a store the preset stops claiming from a store some other preset owns. */
interface KindOutcome {
  result: ApplyResult;
  summary: Record<string, unknown>;
}

function zeroChanges(): ApplyChangeCounts {
  return { created: 0, updated: 0, deleted: 0 };
}

function failOutcome(preset: Preset, messages: string[]): KindOutcome {
  return {
    result: {
      kind: preset.kind,
      name: preset.name,
      action: "FAILED",
      changes: zeroChanges(),
      messages,
    },
    summary: { reason: messages[0] ?? "failed", messages },
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Generic "reconcile a child collection to exact desired state" diff.
 *  Shared by ImportFieldMapping and ImportValueMapping reconciliation
 *  (and, structurally, would work for any keyed child list). */
interface Reconciliation<TExisting, TDesired> {
  toCreate: TDesired[];
  toUpdate: Array<{ existing: TExisting; desired: TDesired }>;
  toDelete: TExisting[];
}

function reconcile<TExisting, TDesired>(
  existing: TExisting[],
  desired: TDesired[],
  keyOfExisting: (e: TExisting) => string,
  keyOfDesired: (d: TDesired) => string,
  isEqual: (e: TExisting, d: TDesired) => boolean,
): Reconciliation<TExisting, TDesired> {
  const existingByKey = new Map(existing.map((e) => [keyOfExisting(e), e]));
  const desiredByKey = new Map(desired.map((d) => [keyOfDesired(d), d]));

  const toCreate: TDesired[] = [];
  const toUpdate: Array<{ existing: TExisting; desired: TDesired }> = [];
  for (const [key, d] of desiredByKey) {
    const e = existingByKey.get(key);
    if (!e) toCreate.push(d);
    else if (!isEqual(e, d)) toUpdate.push({ existing: e, desired: d });
  }
  const toDelete = existing.filter((e) => !desiredByKey.has(keyOfExisting(e)));

  return { toCreate, toUpdate, toDelete };
}

async function recordApply(
  db: PrismaClient,
  preset: Preset,
  opts: ApplyPresetOpts,
  outcome: KindOutcome,
): Promise<ApplyResult> {
  const { result, summary } = outcome;
  const level = result.action === "FAILED" ? "warn" : "info";
  logger[level](`applyPreset ${result.kind}/${result.name}: ${result.action}`, {
    presetKind: result.kind,
    presetName: result.name,
    action: result.action,
    source: opts.source,
    dryRun: Boolean(opts.dryRun),
    changes: result.changes,
  });

  auditLog("CONFIG_PRESET_APPLY", opts.actor ?? "unattended", {
    presetKind: result.kind,
    presetName: result.name,
    action: result.action,
    source: opts.source,
    dryRun: Boolean(opts.dryRun),
    changes: result.changes,
  });

  // Dry run computes and reports the diff and writes NOTHING — not even
  // this durable audit row. A dry run is a read-only simulation.
  if (opts.dryRun) return result;

  // The durable audit row is a RECORD of the apply, not a precondition for
  // it: by this point (for import-definition and traffic-store-mapping
  // alike) the target-table writes already committed in their own
  // transaction above. A failure writing THIS row — a DB hiccup, a
  // serialization edge case — must not look like the whole apply failed,
  // and critically must not throw back into applyBundle()'s loop: an
  // uncaught throw here would abort the loop and silently skip every
  // remaining preset in the bundle, including a later preset's declarative
  // delete. Log it and keep going; the ApplyResult returned to the caller
  // (and printed by the CLI) already reflects what actually happened.
  try {
    await db.configChangeLog.create({
      data: {
        presetKind: result.kind,
        presetName: result.name,
        action: result.action,
        source: opts.source,
        actor: opts.actor ?? null,
        summary: summary as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logError(`applyPreset: failed to write ConfigChangeLog for ${result.kind}/${result.name}`, err, {
      presetKind: result.kind,
      presetName: result.name,
      action: result.action,
      source: opts.source,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// kind: import-definition
// ---------------------------------------------------------------------------

interface DesiredDefinitionFields {
  description: string | null;
  targetEntity: string;
  sourceFormat: ImportDefinitionPreset["sourceFormat"];
  importMode: ImportDefinitionPreset["importMode"];
  naturalKeyFields: string[];
  runnerKey: string | null;
  isActive: boolean;
}

interface ExistingDefinitionTop {
  id: number;
  description: string | null;
  targetEntity: string;
  sourceFormat: string;
  importMode: string;
  naturalKeyFields: string[];
  runnerKey: string | null;
  isActive: boolean;
}

function changedTopFields(existing: ExistingDefinitionTop, desired: DesiredDefinitionFields): string[] {
  const out: string[] = [];
  if ((existing.description ?? null) !== desired.description) out.push("description");
  if (existing.targetEntity !== desired.targetEntity) out.push("targetEntity");
  if (existing.sourceFormat !== desired.sourceFormat) out.push("sourceFormat");
  if (existing.importMode !== desired.importMode) out.push("importMode");
  if (!arraysEqual(existing.naturalKeyFields, desired.naturalKeyFields)) out.push("naturalKeyFields");
  if ((existing.runnerKey ?? null) !== desired.runnerKey) out.push("runnerKey");
  if (existing.isActive !== desired.isActive) out.push("isActive");
  return out;
}

function fieldMappingKey(targetField: string): string {
  return targetField;
}

/** JSON-encode the pair rather than joining with a delimiter: targetField
 *  and sourceValue are free text pulled from a source system's own
 *  vocabulary (a payment string, a state name, ...) and may contain any
 *  character at all -- including whatever single-character delimiter we
 *  might otherwise pick, which is exactly how a previous version of this
 *  function broke (it joined with a literal NUL byte, invisible in an
 *  editor and in grep, one careless paste away from colliding with real
 *  data). JSON.stringify's own escaping means two different pairs always
 *  produce two different keys, unconditionally -- there is no delimiter
 *  left to collide with. */
function valueMappingKey(targetField: string, sourceValue: string): string {
  return JSON.stringify([targetField, sourceValue]);
}

interface ExistingFieldMapping {
  id: number;
  sourceColumn: string;
  targetField: string;
  transform: string | null;
  required: boolean;
  sortOrder: number;
}

interface ExistingValueMapping {
  id: number;
  targetField: string;
  sourceValue: string;
  targetValue: string;
}

function buildFieldMappingReconciliation(
  existing: ExistingFieldMapping[],
  preset: ImportDefinitionPreset,
): Reconciliation<ExistingFieldMapping, FieldMappingInput> {
  const desired: FieldMappingInput[] = preset.fieldMappings.map((m, i) => ({
    targetField: m.targetField,
    sourceColumn: m.sourceColumn,
    transform: m.transform ?? null,
    required: m.required,
    sortOrder: i,
  }));
  return reconcile(
    existing,
    desired,
    (e) => fieldMappingKey(e.targetField),
    (d) => fieldMappingKey(d.targetField),
    (e, d) =>
      e.sourceColumn === d.sourceColumn &&
      (e.transform ?? null) === (d.transform ?? null) &&
      e.required === (d.required ?? false) &&
      e.sortOrder === (d.sortOrder ?? 0),
  );
}

function buildValueMappingReconciliation(
  existing: ExistingValueMapping[],
  preset: ImportDefinitionPreset,
): Reconciliation<ExistingValueMapping, ValueMappingInput> {
  const desired = flattenValueMappings(preset.valueMappings);
  return reconcile(
    existing,
    desired,
    (e) => valueMappingKey(e.targetField, e.sourceValue),
    (d) => valueMappingKey(d.targetField, d.sourceValue),
    (e, d) => e.targetValue === d.targetValue,
  );
}

function describeFieldMappingChanges(
  recon: Reconciliation<ExistingFieldMapping, FieldMappingInput>,
): string[] {
  const messages: string[] = [];
  for (const d of recon.toCreate) messages.push(`created field mapping "${d.targetField}" <- "${d.sourceColumn}"`);
  for (const { desired } of recon.toUpdate) messages.push(`updated field mapping "${desired.targetField}"`);
  for (const e of recon.toDelete) messages.push(`deleted field mapping "${e.targetField}"`);
  return messages;
}

function describeValueMappingChanges(
  recon: Reconciliation<ExistingValueMapping, ValueMappingInput>,
): string[] {
  const messages: string[] = [];
  for (const d of recon.toCreate) {
    messages.push(`created value mapping "${d.targetField}:${d.sourceValue}" -> "${d.targetValue}"`);
  }
  for (const { desired } of recon.toUpdate) {
    messages.push(`updated value mapping "${desired.targetField}:${desired.sourceValue}" -> "${desired.targetValue}"`);
  }
  for (const e of recon.toDelete) {
    messages.push(`deleted value mapping "${e.targetField}:${e.sourceValue}"`);
  }
  return messages;
}

async function writeImportDefinitionChanges(
  tx: Prisma.TransactionClient,
  preset: ImportDefinitionPreset,
  desiredTop: DesiredDefinitionFields,
  existing: ExistingDefinitionTop | null,
  definitionChanged: boolean,
  fieldRecon: Reconciliation<ExistingFieldMapping, FieldMappingInput>,
  valueRecon: Reconciliation<ExistingValueMapping, ValueMappingInput>,
): Promise<void> {
  let definitionId: number;
  if (!existing) {
    // Race-safe by construction, not by convention: `existing` was read
    // OUTSIDE this transaction (so a dry run can report the same diff
    // without writing), which means two concurrent applies of the same
    // brand-new preset name can both see `existing === null`. A plain
    // `.create()` here would let both writes through and produce two
    // ImportDefinition rows sharing one `name` — nothing after this could
    // ever reconcile or remove the duplicate, because every lookup in this
    // file is find-BY-name and only ever finds the first. `upsert`, keyed
    // on the `@@unique([name])` constraint (20260804120000_import_
    // definition_name_unique), makes the actual write race-safe: whichever
    // transaction commits first inserts the row; the other converges onto
    // that same row instead of duplicating it.
    const upserted = await tx.importDefinition.upsert({
      where: { name: preset.name },
      create: { name: preset.name, ...desiredTop },
      update: desiredTop,
    });
    definitionId = upserted.id;
  } else {
    definitionId = existing.id;
    if (definitionChanged) {
      await tx.importDefinition.update({ where: { id: definitionId }, data: desiredTop });
    }
  }

  for (const e of fieldRecon.toDelete) {
    await tx.importFieldMapping.delete({ where: { id: e.id } });
  }
  for (const { existing: e, desired: d } of fieldRecon.toUpdate) {
    await tx.importFieldMapping.update({
      where: { id: e.id },
      data: {
        sourceColumn: d.sourceColumn,
        transform: d.transform ?? null,
        required: d.required ?? false,
        sortOrder: d.sortOrder ?? 0,
      },
    });
  }
  for (const d of fieldRecon.toCreate) {
    await tx.importFieldMapping.create({
      data: {
        definitionId,
        targetField: d.targetField,
        sourceColumn: d.sourceColumn,
        transform: d.transform ?? null,
        required: d.required ?? false,
        sortOrder: d.sortOrder ?? 0,
      },
    });
  }

  for (const e of valueRecon.toDelete) {
    await tx.importValueMapping.delete({ where: { id: e.id } });
  }
  for (const { existing: e, desired: d } of valueRecon.toUpdate) {
    await tx.importValueMapping.update({ where: { id: e.id }, data: { targetValue: d.targetValue } });
  }
  for (const d of valueRecon.toCreate) {
    await tx.importValueMapping.create({
      data: {
        definitionId,
        targetField: d.targetField,
        sourceValue: d.sourceValue,
        targetValue: d.targetValue,
      },
    });
  }
}

async function applyImportDefinition(
  db: PrismaClient,
  preset: ImportDefinitionPreset,
  opts: ApplyPresetOpts,
): Promise<KindOutcome> {
  // runnerKey names executable behaviour. An unresolvable one is a hard
  // failure — see the file header for why this differs from targetEntity.
  if (preset.runnerKey && !isRegisteredRunnerKey(preset.runnerKey)) {
    const known = listRegisteredRunnerKeys().join(", ") || "(none)";
    return failOutcome(preset, [
      `runnerKey "${preset.runnerKey}" is not registered. Registered runners: ${known}.`,
    ]);
  }

  // Fetched before the targetEntity check (rather than after, as before) so
  // that check can tell a NEW definition from an EXISTING, currently-active
  // one — see below.
  const existing = await db.importDefinition.findFirst({
    where: { name: preset.name },
    include: { fieldMappings: true, valueMappings: true },
  });

  const knownEntity = getImportEntity(preset.targetEntity);
  let isActive = preset.isActive;
  let forcedInactiveReason: string | null = null;
  if (!knownEntity) {
    const known = IMPORT_ENTITIES.map((e) => e.key).join(", ") || "(none)";
    // "Saved but forced inactive" is the right answer for a NEW definition —
    // that's how a preset documents an intended mapping before its entity
    // exists (ordorite-payment-modes ships exactly this way). It is the
    // WRONG answer for an EXISTING, currently-active definition: a
    // one-character typo in targetEntity would silently switch off a live
    // importer while this function still reports APPLIED and the CLI exits
    // 0. Only a definition that is new, or already inactive (nothing live
    // is being switched off), gets the quiet treatment; an active one gets
    // a loud, hard failure instead.
    if (existing?.isActive) {
      return failOutcome(preset, [
        `targetEntity "${preset.targetEntity}" is not in IMPORT_ENTITIES (known: ${known}) — refusing ` +
          `to silently deactivate the existing, active ImportDefinition "${preset.name}". Fix the typo, ` +
          "or explicitly set isActive: false in the preset if this entity is intentionally going away.",
      ]);
    }
    isActive = false;
    forcedInactiveReason =
      `targetEntity "${preset.targetEntity}" is not in IMPORT_ENTITIES (known: ${known}) — ` +
      "definition saved but forced inactive";
    logger.warn("applyPreset: unknown targetEntity, forcing isActive=false", {
      presetName: preset.name,
      targetEntity: preset.targetEntity,
    });
  }

  const desiredTop: DesiredDefinitionFields = {
    description: preset.description ?? null,
    targetEntity: preset.targetEntity,
    sourceFormat: preset.sourceFormat,
    importMode: preset.importMode,
    naturalKeyFields: preset.naturalKeyFields,
    runnerKey: preset.runnerKey ?? null,
    isActive,
  };

  const fieldRecon = buildFieldMappingReconciliation(existing?.fieldMappings ?? [], preset);
  const valueRecon = buildValueMappingReconciliation(existing?.valueMappings ?? [], preset);

  const definitionIsNew = !existing;
  const definitionChanged = !definitionIsNew && changedTopFields(existing, desiredTop).length > 0;

  const messages: string[] = [];
  if (forcedInactiveReason) messages.push(forcedInactiveReason);
  if (definitionIsNew) messages.push(`created ImportDefinition "${preset.name}"`);
  else if (definitionChanged) {
    messages.push(
      `updated ImportDefinition "${preset.name}" (${changedTopFields(existing, desiredTop).join(", ")})`,
    );
  }
  messages.push(...describeFieldMappingChanges(fieldRecon));
  messages.push(...describeValueMappingChanges(valueRecon));

  const created = (definitionIsNew ? 1 : 0) + fieldRecon.toCreate.length + valueRecon.toCreate.length;
  const updated = (definitionChanged ? 1 : 0) + fieldRecon.toUpdate.length + valueRecon.toUpdate.length;
  const deleted = fieldRecon.toDelete.length + valueRecon.toDelete.length;
  const hasChanges = created > 0 || updated > 0 || deleted > 0;

  const summaryBase = {
    targetEntity: preset.targetEntity,
    runnerKey: preset.runnerKey ?? null,
    forcedInactiveReason,
  };

  if (!hasChanges) {
    return {
      result: {
        kind: preset.kind,
        name: preset.name,
        action: "UNCHANGED",
        changes: zeroChanges(),
        messages: messages.length ? messages : ["no changes"],
      },
      summary: { ...summaryBase, changes: zeroChanges(), messages },
    };
  }

  const changes: ApplyChangeCounts = { created, updated, deleted };

  if (!opts.dryRun) {
    await db.$transaction(
      (tx) =>
        writeImportDefinitionChanges(
          tx,
          preset,
          desiredTop,
          existing,
          definitionChanged,
          fieldRecon,
          valueRecon,
        ),
      TX_TIMEOUT.SHORT,
    );
  }

  return {
    result: { kind: preset.kind, name: preset.name, action: "APPLIED", changes, messages },
    summary: { ...summaryBase, changes, messages },
  };
}

// ---------------------------------------------------------------------------
// kind: traffic-store-mapping
// ---------------------------------------------------------------------------

interface StoreLocationRow {
  id: number;
  name: string;
  trafficSourceNames: string[];
}

function duplicatesOf(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    else seen.add(v);
  }
  return [...dupes];
}

/** A source name claimed by two different stores in the same preset is
 *  ambiguous at match time — reject it rather than guessing. Matched
 *  case-insensitively, same as the preset schema documents for import-time
 *  matching. */
function findDuplicateSourceNameClaim(preset: TrafficStoreMappingPreset): string | null {
  const owner = new Map<string, string>();
  const conflicts: string[] = [];
  for (const store of preset.stores) {
    for (const raw of store.sourceNames) {
      const key = raw.toLowerCase();
      const existingOwner = owner.get(key);
      if (existingOwner && existingOwner !== store.storeLocation) {
        conflicts.push(`"${raw}" claimed by both "${existingOwner}" and "${store.storeLocation}"`);
      } else {
        owner.set(key, store.storeLocation);
      }
    }
  }
  return conflicts.length ? `ambiguous source name(s): ${conflicts.join("; ")}` : null;
}

/** Extracts the `ownedStores` list from a ConfigChangeLog.summary blob,
 *  defensively — `summary` is untyped JSON (see the Prisma model comment),
 *  written by this same file but read back with no schema guarantee. Shared
 *  by previouslyOwnedStores (one preset's own history) and
 *  currentTrafficStoreOwners (every preset's history) below. */
function ownedStoresOf(summary: unknown): string[] {
  if (
    summary &&
    typeof summary === "object" &&
    !Array.isArray(summary) &&
    Array.isArray((summary as Record<string, unknown>).ownedStores)
  ) {
    return ((summary as Record<string, unknown>).ownedStores as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
  }
  return [];
}

/** What store names this SAME preset (by kind + name) last successfully
 *  claimed, read back from its own ConfigChangeLog history. This is how we
 *  know a store block was REMOVED from the file (as opposed to never having
 *  been there) without a blanket wipe of every StoreLocation row — only a
 *  store this preset itself previously claimed is a clearing candidate.
 *  FAILED applies are excluded on purpose: a rejected apply must not corrupt
 *  the ownership history the next apply relies on. */
async function previouslyOwnedStores(db: PrismaClient, presetName: string): Promise<string[]> {
  const last = await db.configChangeLog.findFirst({
    where: {
      presetKind: "traffic-store-mapping",
      presetName,
      action: { in: ["APPLIED", "UNCHANGED"] },
    },
    orderBy: { created: "desc" },
    select: { summary: true },
  });
  return ownedStoresOf(last?.summary);
}

/**
 * For a set of store names, determines which traffic-store-mapping preset
 * (by name) currently owns each one — the most recent APPLIED/UNCHANGED
 * ConfigChangeLog row, across EVERY preset of this kind (not just one
 * preset's own history), whose `summary.ownedStores` still lists that name.
 * A store absent from the returned map has never been claimed by any
 * preset — its `trafficSourceNames`, if it has any, were set some other way
 * (a direct DB write, an old fixture).
 *
 * This is the single source of truth behind "a store may be owned by
 * exactly one traffic-store-mapping preset at a time" (docs/domains/
 * config-presets.md, "Ownership"):
 *   - applyTrafficStoreMapping uses it to FAIL a preset that tries to claim
 *     a store a differently-named preset already owns, instead of the two
 *     presets reclaiming the store from each other on every re-apply.
 *   - dbConfigState.ts uses it to render the live DB back out under each
 *     store's REAL owning preset name, instead of collapsing every store
 *     under one fixed name a re-import might not be entitled to.
 *
 * Scans traffic-store-mapping history newest-first and stops once every
 * requested name has an answer. This kind of preset is applied rarely and a
 * real deployment runs only a handful of distinct ones, so an unbounded scan
 * is fine — this is not a per-request hot path the way getTrafficStoreMap()
 * is.
 */
export async function currentTrafficStoreOwners(
  db: PrismaClient,
  storeNames: readonly string[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (storeNames.length === 0) return owners;
  const remaining = new Set(storeNames);

  const rows = await db.configChangeLog.findMany({
    where: {
      presetKind: "traffic-store-mapping",
      action: { in: ["APPLIED", "UNCHANGED"] },
    },
    orderBy: { created: "desc" },
    select: { presetName: true, summary: true },
  });

  for (const row of rows) {
    if (remaining.size === 0) break;
    for (const name of ownedStoresOf(row.summary)) {
      if (remaining.has(name)) {
        owners.set(name, row.presetName);
        remaining.delete(name);
      }
    }
  }
  return owners;
}

async function applyTrafficStoreMapping(
  db: PrismaClient,
  preset: TrafficStoreMappingPreset,
  opts: ApplyPresetOpts,
): Promise<KindOutcome> {
  const names = preset.stores.map((s) => s.storeLocation);
  const dupeStores = duplicatesOf(names);
  if (dupeStores.length) {
    return failOutcome(preset, [
      `duplicate storeLocation entries in this preset: ${dupeStores.join(", ")}`,
    ]);
  }

  const ambiguous = findDuplicateSourceNameClaim(preset);
  if (ambiguous) return failOutcome(preset, [ambiguous]);

  const found: StoreLocationRow[] = await db.storeLocation.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true, trafficSourceNames: true },
  });
  const foundByName = new Map(found.map((s) => [s.name, s]));
  const missing = names.filter((n) => !foundByName.has(n));
  if (missing.length) {
    return failOutcome(preset, [
      `unknown store(s): ${missing.join(", ")} — a traffic-store-mapping preset maps onto ` +
        "existing stores, it does not create them",
    ]);
  }

  const desiredNames = new Set(names);

  // Single-owner invariant: a store may be claimed by at most one
  // traffic-store-mapping preset at a time (docs/domains/config-presets.md,
  // "Ownership"). Without this check, two differently-named presets that
  // both list the same store reclaim it from each other on every apply —
  // both permanently report APPLIED, and the "winner" is whichever one ran
  // last (for the CLI's file-order loop, whichever file sorts last), which
  // is not idempotent by any reasonable definition. This makes the SECOND
  // preset to claim an already-owned store fail, deterministically, until
  // an operator resolves it on purpose — including the case where "the
  // second preset" is really the first one renamed: a rename that still
  // claims a store it owned under its old name trips this too, which is
  // the intended way to surface an otherwise-silent orphan (see "Renaming a
  // preset" below).
  const owners = await currentTrafficStoreOwners(db, names);
  const conflicts = names
    .map((n) => ({ name: n, owner: owners.get(n) }))
    .filter((o): o is { name: string; owner: string } => Boolean(o.owner) && o.owner !== preset.name);
  if (conflicts.length) {
    return failOutcome(
      preset,
      conflicts.map(
        (c) =>
          `store "${c.name}" is already owned by traffic-store-mapping preset "${c.owner}" — a store ` +
          "may be claimed by only one traffic-store-mapping preset at a time. Remove it from " +
          `"${c.owner}" first (release it there, or apply "${c.owner}" without that store) before ` +
          `claiming it under "${preset.name}". If "${preset.name}" is a rename of "${c.owner}", release ` +
          `the store under "${c.owner}" first — renaming a preset does not carry its ownership history.`,
      ),
    );
  }

  const previousOwned = await previouslyOwnedStores(db, preset.name);
  const clearCandidateNames = previousOwned.filter((n) => !desiredNames.has(n));
  const clearCandidates: StoreLocationRow[] = clearCandidateNames.length
    ? await db.storeLocation.findMany({
        where: { name: { in: clearCandidateNames } },
        select: { id: true, name: true, trafficSourceNames: true },
      })
    : [];

  const updates: Array<{ id: number; name: string; sourceNames: string[] }> = [];
  const clears: Array<{ id: number; name: string }> = [];
  const messages: string[] = [];

  for (const store of preset.stores) {
    const row = foundByName.get(store.storeLocation);
    if (!row) continue; // unreachable: `missing` above already covers this
    const desired = [...new Set(store.sourceNames)].sort((a, b) => a.localeCompare(b));
    const current = [...row.trafficSourceNames].sort((a, b) => a.localeCompare(b));
    if (!arraysEqual(desired, current)) {
      updates.push({ id: row.id, name: row.name, sourceNames: desired });
      messages.push(`store "${row.name}": sourceNames set to [${desired.join(", ")}]`);
    }
  }
  for (const row of clearCandidates) {
    if (row.trafficSourceNames.length > 0) {
      clears.push({ id: row.id, name: row.name });
      messages.push(`store "${row.name}": cleared (no longer claimed by preset "${preset.name}")`);
    }
  }

  const ownedStores = [...desiredNames].sort((a, b) => a.localeCompare(b));
  const changes: ApplyChangeCounts = { created: 0, updated: updates.length, deleted: clears.length };
  const hasChanges = updates.length > 0 || clears.length > 0;

  if (!hasChanges) {
    return {
      result: {
        kind: preset.kind,
        name: preset.name,
        action: "UNCHANGED",
        changes: zeroChanges(),
        messages: ["no changes"],
      },
      summary: { changes: zeroChanges(), ownedStores, messages: [] },
    };
  }

  if (!opts.dryRun) {
    await db.$transaction(async (tx) => {
      for (const u of updates) {
        await tx.storeLocation.update({ where: { id: u.id }, data: { trafficSourceNames: u.sourceNames } });
      }
      for (const c of clears) {
        await tx.storeLocation.update({ where: { id: c.id }, data: { trafficSourceNames: [] } });
      }
    }, TX_TIMEOUT.SHORT);

    // A running server's cached resolver (60s TTL) must not keep serving the
    // pre-apply mapping — force a rebuild on the next call.
    invalidateTrafficStoreMap();
  }

  return {
    result: { kind: preset.kind, name: preset.name, action: "APPLIED", changes, messages },
    summary: { changes, ownedStores, messages },
  };
}
