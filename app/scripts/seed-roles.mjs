#!/usr/bin/env node
// app/scripts/seed-roles.mjs
//
// Seeds/reconciles the built-in roles (lib/auth/permissionCatalog.ts) into
// Role + RolePermission rows. Idempotent -- safe, and expected, to run on
// every deploy right after `prisma migrate deploy`.
//
// Thin ESM launcher, not the implementation, for the same reason as
// apply-preset.mjs: the work needs `@/lib/auth/builtInRoles`, real TypeScript
// with `@/` path aliases that plain Node cannot import. Re-implementing the
// reconciliation in plain JS to avoid that would duplicate the exact logic the
// app itself uses and drift from it the first time either changed.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const implPath = path.join(here, "seed-roles.impl.ts");
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
  console.error(`seed-roles: failed to launch seed-roles.impl.ts under ts-node: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
