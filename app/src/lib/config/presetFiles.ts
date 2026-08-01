// /app/src/lib/config/presetFiles.ts
//
// Node-only: finding preset documents on disk. Kept apart from
// presetSchema.ts / presetSerialize.ts so those two stay importable from
// client components (the admin GUI parses and previews a pasted file in the
// browser without touching this module).
//
// Three config sets, which is the whole point of the layout:
//
//   config/presets/   COMMITTED. Ships with the repo, tuned to the seed
//                     database, and is what a fresh clone gets. This is the
//                     white-box product's default configuration.
//   config/local/     GITIGNORED. A specific deployment's real mappings —
//                     saybrook.yaml, akritos.yaml. Tenant data, not product
//                     code, and per docs/TENANCY.md it must not travel with
//                     the white box.
//   $HOLT_CONFIG_DIR  Optional override, for a deployment that keeps its
//                     config in its own private repo or a mounted secret
//                     volume rather than inside the checkout.
//
// Precedence is local-over-shipped on a (kind, name) collision, so a tenant
// can override one shipped preset without forking or deleting the rest.

import { promises as fs } from "node:fs";
import path from "node:path";

import { MAX_PRESET_BYTES, detectFormat, parsePresetText } from "@/lib/config/presetSerialize";
import type { Preset, PresetBundle } from "@/lib/config/presetSchema";

export const SHIPPED_PRESET_DIR = "presets";
export const LOCAL_PRESET_DIR = "local";

export interface LoadedPreset {
  preset: Preset;
  /** Repo-relative path of the file it came from, for error messages and
   *  for the GUI to show "this row is managed by config/presets/x.yaml". */
  sourceFile: string;
  origin: "shipped" | "local";
}

export interface PresetLoadReport {
  presets: LoadedPreset[];
  /** Non-fatal: a malformed file is reported and skipped rather than taking
   *  the whole load down, because one bad tenant file should not stop the
   *  shipped defaults from applying. The CLI surfaces these and exits
   *  non-zero; the GUI shows them as warnings on the presets page. */
  errors: Array<{ sourceFile: string; messages: string[] }>;
  /** (kind, name) pairs where a local file overrode a shipped one. Reported
   *  explicitly — a silent override is how a deployment ends up running
   *  config nobody remembers writing. */
  overrides: Array<{ kind: string; name: string; shippedFile: string; localFile: string }>;
}

/** Repo root, i.e. the directory that contains `config/` and `app/`. */
export function resolveConfigRoot(): string {
  const override = process.env.HOLT_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  // Next dev/build and the test runner both execute with cwd = app/.
  // Scripts under app/scripts/ do too. Anything else passes the env var.
  return path.resolve(process.cwd(), "..", "config");
}

/**
 * Reject a filename that tries to escape its directory. The GUI and the CLI
 * both take a preset name from user input and turn it into a path; this is
 * the single choke point that keeps `../../.env` from being one of them.
 * Belt and braces: the name is pattern-checked AND the resolved path is
 * verified to still sit under the intended root.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (segment.includes("\0")) throw new Error("invalid path segment: NUL byte");
    if (segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error(`invalid path segment: ${JSON.stringify(segment)}`);
    }
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the config root: ${JSON.stringify(segments.join("/"))}`);
  }
  return target;
}

async function readIfSmallEnough(filePath: string): Promise<string> {
  // stat before read so an enormous file is refused rather than buffered.
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PRESET_BYTES) {
    throw new Error(`file is ${stat.size} bytes, over the ${MAX_PRESET_BYTES}-byte limit`);
  }
  return fs.readFile(filePath, "utf8");
}

async function listPresetFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A missing directory is normal: a fresh clone has no config/local/.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && detectFormat(e.name) !== null && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

async function loadDir(
  root: string,
  subdir: string,
  origin: LoadedPreset["origin"],
): Promise<{ presets: LoadedPreset[]; errors: PresetLoadReport["errors"] }> {
  const dir = path.join(root, subdir);
  const files = await listPresetFiles(dir);
  const presets: LoadedPreset[] = [];
  const errors: PresetLoadReport["errors"] = [];

  for (const file of files) {
    const sourceFile = `config/${subdir}/${file}`;
    try {
      const text = await readIfSmallEnough(safeJoin(dir, file));
      const result = parsePresetText(text, detectFormat(file) ?? undefined);
      if (!result.ok) {
        errors.push({ sourceFile, messages: result.errors });
        continue;
      }
      for (const preset of result.bundle.presets) {
        presets.push({ preset, sourceFile, origin });
      }
    } catch (err) {
      errors.push({ sourceFile, messages: [err instanceof Error ? err.message : String(err)] });
    }
  }
  return { presets, errors };
}

export interface LoadOptions {
  /**
   * Skip config/local/ entirely and load only the committed defaults.
   *
   * Exists for tests that assert something about what this repo SHIPS. Those
   * must not see a developer's own config/local/ overlay — otherwise the
   * assertion passes in CI (where the directory is empty, being gitignored)
   * and fails on every machine that actually has a tenant configured, which
   * is a red build caused by the feature working correctly.
   */
  shippedOnly?: boolean;
}

/**
 * Load every preset from both config sets, applying local-over-shipped
 * precedence. Never throws for content problems — see PresetLoadReport.errors.
 */
export async function loadAllPresets(
  root = resolveConfigRoot(),
  opts: LoadOptions = {},
): Promise<PresetLoadReport> {
  const shipped = await loadDir(root, SHIPPED_PRESET_DIR, "shipped");
  const local = opts.shippedOnly
    ? { presets: [], errors: [] as PresetLoadReport["errors"] }
    : await loadDir(root, LOCAL_PRESET_DIR, "local");

  const byKey = new Map<string, LoadedPreset>();
  const overrides: PresetLoadReport["overrides"] = [];

  for (const loaded of shipped.presets) {
    byKey.set(`${loaded.preset.kind}/${loaded.preset.name}`, loaded);
  }
  for (const loaded of local.presets) {
    const key = `${loaded.preset.kind}/${loaded.preset.name}`;
    const existing = byKey.get(key);
    if (existing) {
      overrides.push({
        kind: loaded.preset.kind,
        name: loaded.preset.name,
        shippedFile: existing.sourceFile,
        localFile: loaded.sourceFile,
      });
    }
    byKey.set(key, loaded);
  }

  return {
    presets: [...byKey.values()].sort((a, b) =>
      `${a.preset.kind}/${a.preset.name}`.localeCompare(`${b.preset.kind}/${b.preset.name}`),
    ),
    errors: [...shipped.errors, ...local.errors],
    overrides,
  };
}

/** Load a single named file. Used by the CLI's `--file` form. The path is
 *  resolved against the config root and traversal-checked.
 *
 *  Accepts BOTH spellings, because both are natural and one of them is what
 *  every doc and error message shows:
 *    --file config/local/saybrook.yaml   (repo-relative, what you'd tab-complete)
 *    --file local/saybrook.yaml          (config-root-relative)
 *  A leading segment equal to the config root's own directory name is dropped
 *  rather than joined, which otherwise resolves to `config/config/local/...`.
 *  Matching on `basename(root)` keeps this working when HOLT_CONFIG_DIR points
 *  somewhere that isn't called "config". */
export async function loadPresetFile(
  relativePath: string,
  root = resolveConfigRoot(),
): Promise<{ bundle: PresetBundle; sourceFile: string } | { errors: string[] }> {
  const segments = relativePath.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) return { errors: ["no file given"] };
  if (segments.length > 1 && segments[0] === path.basename(path.resolve(root))) {
    segments.shift();
  }
  let target: string;
  try {
    target = safeJoin(root, ...segments);
  } catch (err) {
    return { errors: [err instanceof Error ? err.message : String(err)] };
  }
  if (detectFormat(target) === null) {
    return { errors: [`${relativePath}: expected a .yaml, .yml or .json file`] };
  }
  let text: string;
  try {
    text = await readIfSmallEnough(target);
  } catch (err) {
    return { errors: [`${relativePath}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const result = parsePresetText(text, detectFormat(target) ?? undefined);
  if (!result.ok) return { errors: result.errors.map((e) => `${relativePath}: ${e}`) };
  return { bundle: result.bundle, sourceFile: `config/${segments.join("/")}` };
}
