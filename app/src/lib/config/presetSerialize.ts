// /app/src/lib/config/presetSerialize.ts
//
// Text <-> PresetBundle. YAML and JSON are two spellings of one document —
// the owner's framing was "the yaml and json are for gitops," and a shop
// that already lints JSON in CI should not have to adopt YAML to use presets
// (or vice versa). Both go through the same zod schema in presetSchema.ts,
// so neither format can express something the other cannot.
//
// Isomorphic — the `yaml` package runs in the browser and nothing here touches
// `fs` — but note what the GUI actually does today: it imports only
// `detectFormat` (a filename check) and sends the text to
// /api/admin/config/presets/validate, downloading exports from
// /api/admin/config/presets/export. Both are server round-trips. Keeping this
// module client-safe means a future GUI could validate as you type without a
// request; it does not mean it does so now.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  PRESET_SCHEMA_VERSION,
  parsePresetBundle,
  type PresetBundle,
  type PresetParseResult,
} from "@/lib/config/presetSchema";

export type PresetFormat = "yaml" | "json";

/**
 * Hard ceiling on a preset document, in bytes. A mapping file for a large
 * chain runs a few tens of KB; a megabyte means either a mistake or someone
 * probing for a parser DoS. Enforced at every entry point (file read, HTTP
 * upload) rather than trusting any one of them.
 */
export const MAX_PRESET_BYTES = 512 * 1024;

/**
 * YAML parser options, chosen for safety rather than expressiveness:
 *
 * - `maxAliasCount` bounds anchor/alias expansion. This is the billion-laughs
 *   defence: without it a ~200-byte document with nested aliases expands to
 *   gigabytes during parse and takes the process down. 100 is the library
 *   default; we set it explicitly so a future default change cannot quietly
 *   remove the protection.
 * - `customTags: []` declares that we register no tag handlers of our own. It
 *   is NOT a refusal: the core schema still resolves `!!binary` to a Buffer
 *   and `!!timestamp` to a Date, and an unrecognised tag is kept with a
 *   warning rather than rejected. An earlier version of this comment claimed
 *   otherwise; assertPlainData() below is what actually enforces "data only,
 *   never behaviour," by rejecting any value that is not a string, finite
 *   number, boolean, null, array or plain object.
 * - `version: "1.2"` pins the spec so `NO` stays the string "NO" and does not
 *   become boolean false under YAML 1.1 rules. Store names and payment codes
 *   are exactly the kind of short uppercase tokens that this bites.
 */
const YAML_PARSE_OPTIONS = {
  maxAliasCount: 100,
  customTags: [],
  version: "1.2" as const,
};

/**
 * Walks a parsed document and reports every value that is not plain data.
 * Deliberately an allow-list: anything not explicitly permitted is reported,
 * so a future YAML tag that resolves to some new type fails closed instead of
 * quietly flowing into the database.
 */
function assertPlainData(value: unknown, path = "(root)"): Array<{ path: string; kind: string }> {
  if (value === null) return [];
  const t = typeof value;
  if (t === "string" || t === "boolean") return [];
  if (t === "number") {
    return Number.isFinite(value as number) ? [] : [{ path, kind: "non-finite number" }];
  }
  if (t === "bigint" || t === "function" || t === "symbol" || t === "undefined") {
    return [{ path, kind: t }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => assertPlainData(v, `${path}.${i}`));
  }
  if (value instanceof Date) return [{ path, kind: "date (!!timestamp)" }];
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return [{ path, kind: "binary (!!binary)" }];
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return [{ path, kind: `${(value as object).constructor?.name ?? "object"} instance` }];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    assertPlainData(v, `${path === "(root)" ? "" : `${path}.`}${k}`),
  );
}

export function detectFormat(filename: string): PresetFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  return null;
}

/**
 * Parse and validate preset text. `format` may be omitted — YAML 1.2 is a
 * superset of JSON, so the YAML parser reads both; we still prefer the
 * explicit JSON path when we know the format, because JSON.parse gives
 * better error messages for JSON mistakes.
 */
export function parsePresetText(text: string, format?: PresetFormat): PresetParseResult {
  // Byte length, not string length: a document of multi-byte characters is
  // as expensive as its encoded size, which is what the ceiling is about.
  const bytes =
    typeof Buffer !== "undefined"
      ? Buffer.byteLength(text, "utf8")
      : new TextEncoder().encode(text).length;
  if (bytes > MAX_PRESET_BYTES) {
    return {
      ok: false,
      errors: [
        `(root): preset document is ${bytes} bytes, over the ${MAX_PRESET_BYTES}-byte limit`,
      ],
    };
  }

  let data: unknown;
  try {
    data = format === "json" ? JSON.parse(text) : parseYaml(text, YAML_PARSE_OPTIONS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`(root): could not parse ${format ?? "document"} — ${message}`] };
  }

  if (data === null || data === undefined) {
    return { ok: false, errors: ["(root): document is empty"] };
  }

  // Real enforcement of "data only". YAML's core schema can hand back a
  // Buffer (`!!binary`) or a Date (`!!timestamp`), and zod's `z.string()`
  // would simply reject those with a confusing type error deep in a path —
  // or, for a field typed loosely, let them through into the database. Reject
  // them here, by name, so the operator is told what actually happened.
  const exotic = assertPlainData(data);
  if (exotic.length > 0) {
    return {
      ok: false,
      errors: exotic.map(
        (e) => `${e.path}: unsupported ${e.kind} — presets carry plain data only (no YAML tags)`,
      ),
    };
  }

  return parsePresetBundle(data);
}

/**
 * Render a bundle back to text. Key order is fixed rather than
 * whatever-the-object-had so that exporting the same config twice produces
 * byte-identical output — otherwise every GUI export shows up as a spurious
 * diff in the tenant's repo and GitOps becomes noise.
 */
export function serializePresetBundle(bundle: PresetBundle, format: PresetFormat): string {
  const ordered = orderBundle(bundle);
  if (format === "json") return `${JSON.stringify(ordered, null, 2)}\n`;
  return stringifyYaml(ordered, {
    indent: 2,
    lineWidth: 100,
    // Quote only what needs quoting — an unquoted store name reads better in
    // a diff — but never let a value that LOOKS like a number or bool round
    // trip as one.
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

/** Deterministic key order for export. Mirrors the order the schema declares
 *  fields in, which is also the order a human would naturally write them. */
function orderBundle(bundle: PresetBundle): Record<string, unknown> {
  return {
    version: PRESET_SCHEMA_VERSION,
    ...(bundle.description ? { description: bundle.description } : {}),
    presets: bundle.presets.map((preset) => {
      if (preset.kind === "roles") {
        return {
          kind: preset.kind,
          name: preset.name,
          ...(preset.description ? { description: preset.description } : {}),
          // Sorted by key, and each grant list sorted, so a hand-written file
          // and an export of the same policy compare equal. `permissions` is
          // always emitted even when empty: for this kind an empty list is a
          // statement ("this role holds nothing"), not an absence, and the
          // schema requires it.
          roles: [...preset.roles]
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((role) => ({
              key: role.key,
              name: role.name,
              ...(role.description ? { description: role.description } : {}),
              ...(role.rank !== undefined ? { rank: role.rank } : {}),
              permissions: [...role.permissions].sort((a, b) => a.localeCompare(b)),
            })),
        };
      }
      if (preset.kind === "traffic-store-mapping") {
        return {
          kind: preset.kind,
          name: preset.name,
          ...(preset.description ? { description: preset.description } : {}),
          stores: [...preset.stores]
            .sort((a, b) => a.storeLocation.localeCompare(b.storeLocation))
            .map((s) => ({
              storeLocation: s.storeLocation,
              sourceNames: [...s.sourceNames].sort((a, b) => a.localeCompare(b)),
            })),
        };
      }
      return {
        kind: preset.kind,
        name: preset.name,
        ...(preset.description ? { description: preset.description } : {}),
        targetEntity: preset.targetEntity,
        sourceFormat: preset.sourceFormat,
        importMode: preset.importMode,
        ...(preset.naturalKeyFields.length ? { naturalKeyFields: preset.naturalKeyFields } : {}),
        ...(preset.runnerKey ? { runnerKey: preset.runnerKey } : {}),
        ...(preset.isActive ? {} : { isActive: false }),
        fieldMappings: preset.fieldMappings.map((m) => ({
          sourceColumn: m.sourceColumn,
          targetField: m.targetField,
          ...(m.transform ? { transform: m.transform } : {}),
          ...(m.required ? { required: true } : {}),
        })),
        // Sorted so a hand-edited file and a GUI export of the same mappings
        // compare equal.
        valueMappings: Object.fromEntries(
          Object.entries(preset.valueMappings)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([field, pairs]) => [
              field,
              Object.fromEntries(Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b))),
            ]),
        ),
      };
    }),
  };
}
