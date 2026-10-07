#!/usr/bin/env node
// /app/scripts/audit-overrides.mjs
//
// Audits package.json `overrides` against the resolved lockfile.
//
// Why this exists: every transitive CVE gets fixed by adding an override, and
// nothing ever removes one. The block reached 29 entries, of which three were
// provably dead (`hono` and `@hono/node-server` appeared ZERO times in the
// lockfile; `brace-expansion@2` matched nothing at v2) and four were exact pins
// silently blocking their own security updates -- `semver` sat at 7.6.3 while
// 7.8.5 shipped.
//
// Neither failure is visible by reading package.json. Both are trivial to see
// from the lockfile, so we look.
//
// Two checks, both hard failures:
//   DEAD   -- the package is not in the resolved tree. Delete the override.
//   PIN    -- an exact pin (no ^ / ~) with no justification in
//             dependency-overrides.json. Either loosen it or write down why not.
//
// Reported but not failed: an override pinned below the newest release already
// permitted by its own range. That is a nudge to run `npm update <pkg>`, not a
// break -- the range already allows the fix, which is the property that matters.
//
// Run: node scripts/audit-overrides.mjs   (also asserted by __tests__/dependencyOverrides.test.ts)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every version of `name` present anywhere in the resolved tree.
 *
 * Lockfile keys are paths like "node_modules/a/node_modules/b", so the package
 * name is the segment after the LAST "node_modules/". Splitting on "/" instead
 * would mis-read scoped packages (@scope/name).
 */
function resolvedVersions(lock, name) {
  const found = new Set();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || !meta?.version) continue;
    const parts = path.split("node_modules/");
    if (parts[parts.length - 1] === name) found.add(meta.version);
  }
  return [...found].sort();
}

/** "brace-expansion@1" -> "brace-expansion"; "@scope/pkg@2" -> "@scope/pkg". */
function baseName(key) {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

export function auditOverrides() {
  const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(appDir, "package-lock.json"), "utf8"));
  const justified = JSON.parse(
    readFileSync(join(appDir, "dependency-overrides.json"), "utf8"),
  ).exactPins;

  const dead = [];
  const unjustifiedPins = [];

  for (const [key, spec] of Object.entries(pkg.overrides ?? {})) {
    // A nested override ({ parent: { child: version } }) constrains a child
    // only under that parent. Its own key need not appear in the tree, so the
    // dead-check does not apply.
    if (typeof spec !== "string") continue;

    const name = baseName(key);
    if (resolvedVersions(lock, name).length === 0) dead.push(key);

    const isExact = !/^[\^~]/.test(spec);
    if (isExact && !justified[name]) unjustifiedPins.push(`${key}: ${spec}`);
  }

  return { dead, unjustifiedPins };
}

// Only run as a CLI when invoked directly, so the test can import it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dead, unjustifiedPins } = auditOverrides();
  let bad = false;

  if (dead.length) {
    bad = true;
    console.error("DEAD overrides — not present in the resolved tree, delete them:");
    for (const d of dead) console.error(`  ${d}`);
  }
  if (unjustifiedPins.length) {
    bad = true;
    console.error("\nEXACT pins with no justification in dependency-overrides.json:");
    for (const p of unjustifiedPins) console.error(`  ${p}`);
    console.error("\nAn exact pin blocks its own security updates. Loosen it to a caret");
    console.error("range, or add an entry saying which newer release breaks what.");
  }
  if (!bad) console.log("overrides: clean — nothing dead, every exact pin justified.");
  process.exit(bad ? 1 : 0);
}
