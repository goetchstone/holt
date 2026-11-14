// /app/src/lib/databaseReplaced.ts
//
// Server-only. What runs after the whole database has been replaced underneath
// the running app processes: an admin restore from a backup
// (pages/api/admin/database/restore.ts) and a practice copy going back to its
// starting point (pages/api/admin/database/practice.ts). One function for both,
// so the two cannot drift apart again (rule 42).
//
// The database that came back may predate the last upgrade. App processes no
// longer migrate when they start (docker-compose.yml runs `RUN_MIGRATIONS=false`
// and migrates once, in the `migrate` service, on `docker compose up`), so a
// restart would not bring it up to date either. This does what a server does on
// boot: the migrations (the same CLI, by the same path, as the `migrate`
// service and docker-entrypoint.sh) and the built-in roles (instrumentation.ts).
// Then every cache in every app process reloads, since an id any of them held
// may now name a different row (lib/cacheGeneration.ts). The bump comes after the
// migrations, so the table it writes is there even when the backup predates it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { bumpAllCacheGenerations } from "@/lib/cacheGeneration";

const run = promisify(execFile);

export async function bringReplacedDatabaseUpToDate(): Promise<void> {
  await run("node_modules/.bin/prisma", ["migrate", "deploy"], { timeout: 120_000 });
  await syncBuiltInRoles();
  await bumpAllCacheGenerations();
}
