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

function valueMappingKey(targetField: string, sourceValue: string): string {
  return `${targetField} ${sourceValue}`;
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
    const created = await tx.importDefinition.create({ data: { name: preset.name, ...desiredTop } });
    definitionId = created.id;
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

  const knownEntity = getImportEntity(preset.targetEntity);
  let isActive = preset.isActive;
  let forcedInactiveReason: string | null = null;
  if (!knownEntity) {
    isActive = false;
    const known = IMPORT_ENTITIES.map((e) => e.key).join(", ") || "(none)";
    forcedInactiveReason =
      `targetEntity "${preset.targetEntity}" is not in IMPORT_ENTITIES (known: ${known}) — ` +
      "definition saved but forced inactive";
    logger.warn("applyPreset: unknown targetEntity, forcing isActive=false", {
      presetName: preset.name,
      targetEntity: preset.targetEntity,
    });
  }

  const existing = await db.importDefinition.findFirst({
    where: { name: preset.name },
    include: { fieldMappings: true, valueMappings: true },
  });

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
  const summary = last?.summary;
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
