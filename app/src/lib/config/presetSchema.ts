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
// The one import beyond zod is lib/auth/permissionCatalog.ts, which is itself
// pure data with no imports of its own, so the isomorphic promise above still
// holds. That import is what lets the `roles` kind reject an unknown
// permission key HERE, at parse time, rather than at apply time the way an
// unknown `targetEntity` or `runnerKey` has to be (those catalogs are
// server-side and this file cannot see them). It is the better place when it
// is available: a preset is reviewed in a diff, so a typo should fail in the
// review, in the GUI as you type, and in CI — not quietly at 2am against a
// production database.
//
// Rule 7 (shared client/server contracts live in one file) applies here.

import { z } from "zod";

import {
  isPermissionKey,
  stripBaselinePermissions,
  PERMISSION_KEYS,
} from "@/lib/auth/permissionCatalog";

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
// anything in it is public by construction. findSecrets() below is the
// tripwire that keeps a well-meaning contributor from pasting one in.
//
// Anchored to a whole key segment, NOT a bare substring. The first version
// tested `/pass|secret|token/` against every key at every depth, which meant
// ordinary retail data tripped it: a payment type of "Bus Pass", a store on
// "Passaic Ave", a vendor called "Tokenworks" made the entire bundle
// unloadable — and, worse, made a GUI export of that data un-re-importable,
// silently breaking the round-trip the whole design rests on. A tripwire that
// fires on the business's own vocabulary gets disabled, and then it protects
// nothing.
const SECRET_LIKE_KEY =
  /^(?:pass(?:word|wd)?|secret|token|auth|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|client[-_]?secret)$/i;

// Keys are only half the problem: `{ "note": "sk-live-abc123" }` has an
// innocent key. Rather than guess at entropy (which false-positives on
// barcodes, SKUs and hashes — exactly what a retail preset is full of), match
// the small set of credential formats that announce themselves.
const SECRET_LIKE_VALUE = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI-style secret key
  /^sk_(?:live|test)_[A-Za-z0-9]{16,}$/, // Stripe secret key
  /^rk_(?:live|test)_[A-Za-z0-9]{16,}$/, // Stripe restricted key
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub token
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/, // Slack token
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
];

/**
 * Keys under these nodes are DATA, not configuration: `valueMappings` is
 * keyed by target field and then by the source system's own vocabulary, so a
 * key there is a payment string or a state name the business chose. Scanning
 * them for credential-shaped names is a category error. Their VALUES are
 * still scanned — a pasted token is a pasted token wherever it lands.
 */
const DATA_KEYED_NODES = new Set(["valueMappings"]);

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
  .refine((d) => d.importMode !== "RECONCILE" || Boolean(d.runnerKey), {
    message:
      "importMode RECONCILE requires a runnerKey — a full-state re-export must diff against existing data, which is code, not mapping",
    path: ["runnerKey"],
  })
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
// kind: roles
// --------------------------------------------------------------------------
//
// Who may do what, kept in git. A deployment's role set — "our designers
// cannot discount", "Floor Lead exists and holds these eleven capabilities" —
// is a fact about ONE deployment and not about the product (rule 61), which
// makes it a preset rather than a literal in `src/`. permissionCatalog.ts's
// header already promises this shape: the vocabulary is code, which role
// holds which key is data.
//
// Rule 62 holds throughout: a `permissions` entry NAMES a capability from the
// compile-time catalog. It cannot define one, and a name that resolves to
// nothing is refused rather than stored.

/**
 * A preset's permission list -> the keys that actually become RolePermission
 * rows.
 *
 * The baseline (`staff.self`) is dropped here, not rejected above. It is
 * DECLARED in PERMISSIONS — so a preset naming it parses like any other key —
 * but it is the floor every role already holds, never stored as a row, and
 * neither grantable nor revocable. A preset listing it is stating something
 * already true, and refusing a statement of fact is a worse error than
 * accepting one: the roles admin screen renders the baseline as an always-on
 * checkbox, so a file written from what that screen shows would otherwise fail
 * to load over a no-op.
 *
 * stripBaselinePermissions() is the catalog's own function, shared with the
 * built-in role seeder and the admin API's write paths — the floor is
 * vocabulary and permissionCatalog.ts owns the vocabulary (rules 6 and 37).
 * Duplicates collapse and the result is sorted, so applyPreset.ts's diff is
 * order-independent and a re-ordered YAML list is not a change.
 */
export function grantablePermissions(permissions: readonly string[]): string[] {
  return [...new Set(stripBaselinePermissions(permissions))].sort((a, b) => a.localeCompare(b));
}

/** Names the sibling keys in the same domain when a permission key is
 *  unrecognized. Listing all ~45 keys would make the error unreadable; the
 *  domain the author was aiming at is almost always where the typo is. */
function nearbyPermissionHint(key: string): string {
  const domain = key.split(".")[0];
  const siblings = PERMISSION_KEYS.filter((k) => k.startsWith(`${domain}.`));
  return siblings.length > 0 ? ` Keys in the "${domain}" domain: ${siblings.join(", ")}.` : "";
}

/**
 * Role.key. UPPER_SNAKE, matching the eight built-ins exactly — their keys ARE
 * the StaffRole enum values, and the Role.key schema doc explains why that
 * equality is load-bearing. A deployment's own roles follow the same spelling
 * so the two sets read as one vocabulary in the database, in a grep, and in
 * this file.
 */
export const roleKeySchema = z
  .string()
  .min(1, "key is required")
  .max(64, "key must be 64 characters or fewer")
  .regex(
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
    "key must be UPPER_SNAKE_CASE, like the built-in role keys (e.g. FLOOR_LEAD)",
  );

export const rolePresetEntrySchema = z.object({
  key: roleKeySchema,
  /** Role.name — what an operator sees. Reconciled from code for built-ins
   *  (see applyPreset.ts, which refuses a preset that contradicts it). */
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  /** Role.rank, the anti-escalation ladder in lib/auth/roleDecision.ts. Only
   *  ever WRITTEN for a deployment's own roles: built-in ranks are reconciled
   *  from code, and permissionResolver.ts floors every built-in at its
   *  compile-time value with max(), so no file can lower SUPER_ADMIN into
   *  impersonation range. Bounded because rank is compared, never summed —
   *  a five-digit value is a typo, not intent. */
  rank: z.number().int().min(0).max(100).optional(),
  /**
   * The role's WHOLE capability set — not additions to it. Required, unlike
   * the optional collections on the other kinds, precisely because of that:
   * an omitted key would read as "no opinion" while meaning "revoke
   * everything". Make the author write `permissions: []` and mean it.
   */
  permissions: z.array(z.string().min(1).max(100)).max(500),
  /**
   * Refused outright rather than ignored. `grantsAllPermissions` is the
   * wildcard that holds every permission including ones a future release adds
   * — a config file that could set it would be a config file that mints a
   * superuser, which is not a config file. It has to be DECLARED to be
   * rejected: zod strips unknown keys, so leaving it out would silently drop
   * the line and leave the author believing they had granted it.
   */
  grantsAllPermissions: z
    .never({
      error:
        "grantsAllPermissions cannot be set from a preset — a config file must not be able to mint a superuser. The wildcard belongs to the built-in Owner role and is reconciled from code (lib/auth/permissionCatalog.ts).",
    })
    .optional(),
  /** Same treatment, same reason: `isSystem` decides whether the built-in
   *  role seeder owns a row. A preset that could set it could hand its own
   *  invented role to the seeder, or take a shipped one away from it. */
  isSystem: z
    .never({
      error:
        "isSystem cannot be set from a preset — it marks a role as shipped with the product, and is owned by the built-in role seeder (lib/auth/builtInRoles.ts).",
    })
    .optional(),
});

export const rolesPresetSchema = z
  .object({
    kind: z.literal("roles"),
    name: presetNameSchema,
    description: z.string().max(2000).optional(),
    roles: z.array(rolePresetEntrySchema).max(200).default([]),
  })
  .superRefine((preset, ctx) => {
    const seen = new Set<string>();
    preset.roles.forEach((role, i) => {
      // Role.key is @unique, so the second entry would simply overwrite the
      // first — in a GitOps flow that reads as "my change did nothing".
      if (seen.has(role.key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate role key "${role.key}" — each key may appear once per preset`,
          path: ["roles", i, "key"],
        });
      }
      seen.add(role.key);

      role.permissions.forEach((permission, j) => {
        // The baseline (`staff.self`) is in PERMISSIONS, so it passes here and
        // is dropped by grantablePermissions() before anything is stored.
        if (isPermissionKey(permission)) return;
        // Refused at PARSE time, naming the key. A preset is reviewed in a
        // diff and applied unattended; a typo that merely failed to match
        // would store a RolePermission row granting nothing at all, and the
        // admin UI would render it as a grant. Whoever holds the role finds
        // out at their first 403, months later. Fail in the review instead.
        ctx.addIssue({
          code: "custom",
          message:
            `unknown permission "${permission}" — no such key in the permission catalog ` +
            `(lib/auth/permissionCatalog.ts).${nearbyPermissionHint(permission)}`,
          path: ["roles", i, "permissions", j],
        });
      });
    });
  });

// --------------------------------------------------------------------------
// The bundle
// --------------------------------------------------------------------------

export const presetSchema = z.discriminatedUnion("kind", [
  importDefinitionPresetSchema,
  trafficStoreMappingPresetSchema,
  rolesPresetSchema,
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
export type RolePresetEntry = z.infer<typeof rolePresetEntrySchema>;
export type RolesPreset = z.infer<typeof rolesPresetSchema>;
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
function findSecrets(value: unknown, path: string[] = [], inDataNode = false): string[] {
  if (typeof value === "string") {
    return SECRET_LIKE_VALUE.some((re) => re.test(value.trim()))
      ? [`${path.join(".") || "(root)"} (value looks like a credential)`]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findSecrets(v, [...path, String(i)], inDataNode));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const here = [...path, k];
      // Once inside a data-keyed node, every key below is the source system's
      // vocabulary, not ours — check values only.
      const hit = !inDataNode && SECRET_LIKE_KEY.test(k) ? [here.join(".")] : [];
      return [...hit, ...findSecrets(v, here, inDataNode || DATA_KEYED_NODES.has(k))];
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

  const secretKeys = findSecrets(input);
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
