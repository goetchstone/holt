#!/usr/bin/env node
// app/scripts/seed-coverage.mjs
//
// Measures a seeded database against prisma/seed/coverage.ts. See
// seed-coverage.impl.ts for what it checks and why.
//
// Thin ESM launcher, not the implementation: the work needs real TypeScript
// with `@/` path aliases that plain Node cannot import. Same shape as
// seed-roles.mjs.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const implPath = path.join(here, "seed-coverage.impl.ts");
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
  console.error(`seed-coverage: failed to launch seed-coverage.impl.ts under ts-node: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
