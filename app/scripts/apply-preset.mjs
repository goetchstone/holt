#!/usr/bin/env node
// app/scripts/apply-preset.mjs
//
// GitOps door for config presets (config/presets/, config/local/) -- see
// config/presets/README.md and src/lib/config/applyPreset.ts.
//
// This file is a thin ESM launcher, not the implementation. Its usage
// contract is `node scripts/apply-preset.mjs ...` (plain Node, no special
// flags), matching every other script in this directory -- but the actual
// work needs `@/lib/config/applyPreset`, `@/lib/config/presetFiles`, etc.:
// real TypeScript with `@/` path aliases, which plain Node cannot import
// (there is no loader wired up for that here, unlike ts-node's CommonJS
// require hook). Re-implementing applyPreset.ts's diffing/reconciliation
// logic in plain JS just to avoid that would be exactly the kind of
// duplication config presets exist to get rid of, and would drift the
// CLI's behaviour from the GUI's the first time either one changed.
//
// So: re-exec the real implementation (apply-preset.impl.ts, next to this
// file) under ts-node's classic loader + tsconfig-paths -- the same
// combination `npm run seed:demo` already uses to run application TS from
// a script (see package.json's "seed:demo" and
// prisma/seed/tsconfig.seed.json's header for why a dedicated CommonJS
// tsconfig rather than the project root's ESM/bundler one). That
// combination is reused here as-is via TS_NODE_PROJECT, rather than
// forking a near-duplicate tsconfig for one more script.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const implPath = path.join(here, "apply-preset.impl.ts");
const tsNodeBin = path.join(appRoot, "node_modules", ".bin", "ts-node");
const tsNodeProject = path.join(appRoot, "prisma", "seed", "tsconfig.seed.json");

const result = spawnSync(
  tsNodeBin,
  ["-r", "tsconfig-paths/register", implPath, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    cwd: appRoot,
    env: {
      ...process.env,
      TS_NODE_PROJECT: process.env.TS_NODE_PROJECT || tsNodeProject,
    },
  },
);

if (result.error) {
  console.error(`apply-preset: failed to launch apply-preset.impl.ts under ts-node: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
