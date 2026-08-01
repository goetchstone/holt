// /app/src/lib/config/presetSchema.ts
//
// The wire contract for holt config presets — the GitOps half of the
// "configuration, not code" line that docs/domains/imports-configurable.md
// draws. A preset file is a declarative description of per-deployment
// mappings (which source column feeds which field, which vendor's payment
// string means CARD, which traffic-counter name is which store) that today
// live either as database rows or, worse, as hardcoded object literals.
//
// This file is deliberately ISOMORPHIC: pure zod, no `fs`, no Prisma, no
// `yaml`. The admin GUI validates with exactly the same schema the CLI does,
// so a preset that a human hand-writes and a preset the GUI exports are the
// same artifact and cannot drift. Node-only concerns (reading files off
// disk) live in presetFiles.ts; serialization lives in presetSerialize.ts;
// database application lives in applyPreset.ts.
//
// Rule 7 (shared client/server contracts live in one file) applies here.

import { z } from "zod";

/**
 * Bumped only for a BREAKING change to the preset shape. Additive fields do
 * not bump it — an older file must keep loading against a newer holt, since
 * presets are checked into other people's repos and we do not get to
 * migrate those.
 */
export const PRESET_SCHEMA_VERSION = 1;

/** Guards every free-text identifier that ends up in a filename, a database
 *  unique key, or a URL segment. Lowercase kebab keeps the same preset
 *  addressable by the CLI (`--name`), the GUI, and the filesystem without
 *  per-surface escaping rules. */
export const presetNameSchema = z
  .string()
  .min(1, "name is required")
  .max(64, "name must be 64 characters or fewer")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "name must be lowercase kebab-case (letters, digits, single hyphens)",
  );

// A preset never carries secrets. API keys, tokens and passwords belong in
// IntegrationCredential (encrypted at rest, see docs/SECRETS.md) — a preset
// is meant to be committed to git and reviewed in a pull request, so
// anything in it is public by construction. `refineNoSecrets` below is the
// tripwire that keeps a well-meaning contributor from pasting one in.
const SECRET_LIKE_KEY = /(?:pass(?:word|wd)?|secret|token|api[-_]?key|private[-_]?key|credential)/i;

// --------------------------------------------------------------------------
// kind: import-definition
// --------------------------------------------------------------------------

// Mirrors the ImportMode / ImportTransform enums in prisma/schema.prisma and
// the string unions in lib/imports/types.ts. Kept as literals rather than
// importing the Prisma enum so this file stays client-safe.
export const importModeSchema = z.enum(["INSERT_ONLY", "UPSERT", "RECONCILE"]);
export const importSourceFormatSchema = z.enum(["CSV", "XLSX"]);
export const importTransformSchema = z.enum([
  "TRIM",
  "UPPERCASE",
  "LOWERCASE",
  "NUMBER",
  "DATE",
  "CURRENCY",
]);

export const fieldMappingSchema = z.object({
  /** The uploaded file's column header, verbatim. Case and spacing matter —
   *  this is matched against a real CSV header, so it is NOT normalized. */
  sourceColumn: z.string().min(1).max(200),
  /** ImportFieldDef.key on the target entity (see lib/genericImport.ts). */
  targetField: z.string().min(1).max(100),
  transform: importTransformSchema.nullish(),
  required: z.boolean().default(false),
});

/**
 * Value mappings are authored as a nested map — `paymentType: { "Card
 * Connect": CARD }` — rather than as a list of {targetField, sourceValue,
 * targetValue} triples. The triple is the storage shape (one
 * ImportValueMapping row each); the nested map is the AUTHORING shape,
 * because a human editing forty payment strings in YAML should not have to
 * repeat `targetField:` forty times. flattenValueMappings() below converts.
 */
export const valueMappingsSchema = z.record(
  z.string().min(1).max(100),
  z.record(z.string().max(500), z.string().max(500)),
);

export const importDefinitionPresetSchema = z
  .object({
    kind: z.literal("import-definition"),
    name: presetNameSchema,
    description: z.string().max(2000).optional(),
    /** Key into IMPORT_ENTITIES (lib/genericImport.ts), e.g. "customer".
     *  Not enumerated here on purpose: the entity catalog is server-side and
     *  grows, and this schema is client-safe. An unknown entity is resolved
     *  at APPLY time, where applyPreset() saves the definition but forces
     *  `isActive: false` and records the reason — that is how a preset
     *  documents an intended mapping before its entity exists (the shipped
     *  `ordorite-payment-modes` preset does exactly this). Contrast
     *  `runnerKey` below, where an unknown value is a hard failure. */
    targetEntity: z.string().min(1).max(100),
    sourceFormat: importSourceFormatSchema.default("CSV"),
    importMode: importModeSchema.default("INSERT_ONLY"),
    naturalKeyFields: z.array(z.string().min(1).max(100)).default([]),
    /** Names a compile-time-registered runner (lib/imports/runnerRegistry.ts).
     *  A preset can REFERENCE a runner but can never define one — that is the
     *  security boundary: config selects behaviour from a fixed catalog, it
     *  never supplies behaviour. */
    runnerKey: z.string().max(100).nullish(),
    isActive: z.boolean().default(true),
    fieldMappings: z.array(fieldMappingSchema).max(500).default([]),
    valueMappings: valueMappingsSchema.default({}),
  })
  // These two mirror the DB-level constraints so a bad preset is rejected at
  // the door (in the GUI, before any write) instead of by a Postgres error.
  .refine(
    (d) => d.importMode !== "RECONCILE" || Boolean(d.runnerKey),
    {
      message:
        "importMode RECONCILE requires a runnerKey — a full-state re-export must diff against existing data, which is code, not mapping",
      path: ["runnerKey"],
    },
  )
  .refine((d) => d.importMode !== "UPSERT" || d.naturalKeyFields.length > 0, {
    message: "importMode UPSERT requires at least one entry in naturalKeyFields",
    path: ["naturalKeyFields"],
  })
  .refine(
    (d) => new Set(d.fieldMappings.map((m) => m.targetField)).size === d.fieldMappings.length,
    {
      message:
        "duplicate targetField in fieldMappings — each target field may be fed by at most one source column",
      path: ["fieldMappings"],
    },
  );

// --------------------------------------------------------------------------
// kind: traffic-store-mapping
// --------------------------------------------------------------------------

/**
 * Replaces the hardcoded AXPER_TO_STORE_LOCATION / STORE_DISPLAY_NAMES
 * literals that used to sit in lib/storeColors.ts. A traffic counter (Axper
 * and friends) reports its own label for each door; the POS knows the store
 * by a different name. One StoreLocation may own several counter names — two
 * co-located buildings counted separately still roll up to one store.
 */
export const trafficStoreMappingPresetSchema = z.object({
  kind: z.literal("traffic-store-mapping"),
  name: presetNameSchema,
  description: z.string().max(2000).optional(),
  stores: z
    .array(
      z.object({
        /** StoreLocation.name — must already exist; a preset maps onto
         *  stores, it does not create them (creating a store has downstream
         *  effects on registers, stock locations and receiving defaults that
         *  a mapping file has no business triggering). */
        storeLocation: z.string().min(1).max(200),
        /** The counter's own store labels. Matched case-insensitively at
         *  import time, stored verbatim. */
        sourceNames: z.array(z.string().min(1).max(200)).min(1),
      }),
    )
    .max(500)
    .default([]),
});

// --------------------------------------------------------------------------
// The bundle
// --------------------------------------------------------------------------

export const presetSchema = z.discriminatedUnion("kind", [
  importDefinitionPresetSchema,
  trafficStoreMappingPresetSchema,
]);

export const presetBundleSchema = z
  .object({
    version: z.literal(PRESET_SCHEMA_VERSION),
    /** Free-text, for the human reading the file in a diff. */
    description: z.string().max(2000).optional(),
    presets: z.array(presetSchema).max(200),
  })
  .superRefine((bundle, ctx) => {
    // (kind, name) is the idempotency key for apply — a duplicate inside one
    // file means the second silently overwrites the first, which in a GitOps
    // flow reads as "my change did nothing."
    const seen = new Set<string>();
    bundle.presets.forEach((p, i) => {
      const key = `${p.kind}/${p.name}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate preset ${key} — (kind, name) must be unique within a bundle`,
          path: ["presets", i, "name"],
        });
      }
      seen.add(key);
    });
  });

export type FieldMappingPreset = z.infer<typeof fieldMappingSchema>;
export type ImportDefinitionPreset = z.infer<typeof importDefinitionPresetSchema>;
export type TrafficStoreMappingPreset = z.infer<typeof trafficStoreMappingPresetSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type PresetBundle = z.infer<typeof presetBundleSchema>;
export type PresetKind = Preset["kind"];

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

export interface PresetParseFailure {
  ok: false;
  /** Human-readable, one line per problem, each prefixed with its path so an
   *  operator can find it in a 300-line YAML file. */
  errors: string[];
}
export interface PresetParseSuccess {
  ok: true;
  bundle: PresetBundle;
}
export type PresetParseResult = PresetParseSuccess | PresetParseFailure;

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Rejects anything that looks like a credential. Presets are meant to be
 * committed and reviewed in public; a token that reaches this function has
 * already been written to disk, but refusing to APPLY it is what stops it
 * from also being copied into the database and shown in the GUI.
 */
function findSecretLikeKeys(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findSecretLikeKeys(v, [...path, String(i)]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const here = [...path, k];
      const hit = SECRET_LIKE_KEY.test(k) ? [here.join(".")] : [];
      return [...hit, ...findSecretLikeKeys(v, here)];
    });
  }
  return [];
}

/**
 * Validate an already-parsed JS object (from YAML, from JSON, or straight
 * from the GUI's form state) against the bundle schema.
 *
 * Accepts either a full bundle or a single bare preset, normalizing the
 * latter into a one-entry bundle. Both shapes appear in the wild: a bundle
 * is what a tenant's `config/local/saybrook.yaml` looks like, a bare preset
 * is what the GUI exports when you hit "export this one."
 */
export function parsePresetBundle(input: unknown): PresetParseResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: ["(root): expected a preset object or a bundle with { version, presets }"],
    };
  }

  const secretKeys = findSecretLikeKeys(input);
  if (secretKeys.length > 0) {
    return {
      ok: false,
      errors: [
        `refusing to load a preset containing credential-like keys (${secretKeys.join(", ")}) — ` +
          "presets are committed to git in plaintext; put secrets in Integration Credentials instead (docs/SECRETS.md)",
      ],
    };
  }

  const record = input as Record<string, unknown>;

  // Bare single preset — no `version`, but a recognizable `kind`.
  if (!("version" in record) && typeof record.kind === "string") {
    const single = presetSchema.safeParse(record);
    if (!single.success) return { ok: false, errors: formatIssues(single.error) };
    return {
      ok: true,
      bundle: { version: PRESET_SCHEMA_VERSION, presets: [single.data] },
    };
  }

  if (typeof record.version === "number" && record.version !== PRESET_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `version: unsupported preset version ${record.version} — this holt understands version ${PRESET_SCHEMA_VERSION}`,
      ],
    };
  }

  const parsed = presetBundleSchema.safeParse(record);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
  return { ok: true, bundle: parsed.data };
}

// --------------------------------------------------------------------------
// Shape conversion
// --------------------------------------------------------------------------

/** Authoring shape (nested map) -> storage shape (one row per triple). */
export function flattenValueMappings(
  valueMappings: Record<string, Record<string, string>>,
): Array<{ targetField: string; sourceValue: string; targetValue: string }> {
  return Object.entries(valueMappings).flatMap(([targetField, pairs]) =>
    Object.entries(pairs).map(([sourceValue, targetValue]) => ({
      targetField,
      sourceValue,
      targetValue,
    })),
  );
}

/** Storage shape -> authoring shape. Used when the GUI exports a definition
 *  that an operator built by hand, so a round-trip through the UI produces a
 *  file identical to one a human would have written. */
export function nestValueMappings(
  rows: Array<{ targetField: string; sourceValue: string; targetValue: string }>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    (out[row.targetField] ??= {})[row.sourceValue] = row.targetValue;
  }
  return out;
}
