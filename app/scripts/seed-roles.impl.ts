// app/scripts/seed-roles.impl.ts
//
// The real implementation behind `node scripts/seed-roles.mjs` -- see that
// file's header for why the launcher/impl split exists (same reason as
// apply-preset.mjs: `@/` path aliases need ts-node).
//
// Reconciles the eight built-in roles from lib/auth/permissionCatalog.ts into
// Role/RolePermission rows. Idempotent: a second run prints "unchanged" and
// writes nothing.
//
// Usage (from app/):
//   node scripts/seed-roles.mjs
//   node scripts/seed-roles.mjs --dry-run
//
// This runs on EVERY deploy, from docker-entrypoint.sh right after
// `prisma migrate deploy`, because a database with the tables and no roles is
// a deployment where nobody can do anything. It is intentionally NOT part of
// prisma/seed/demo -- that only runs when someone asks for demo data.
//
// Data safety: this writes product data (the roles that ship with holt), not
// tenant data, so unlike apply-preset.mjs it does not gate on the database
// name -- it has to be able to run against production, which is the whole
// point. It only ever touches Role rows with isSystem = true.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  // Prisma 7 requires the pg driver adapter -- a bare `new PrismaClient()`
  // throws at construction. Mirrors src/lib/prisma.ts.
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const result = await syncBuiltInRoles({ prisma, dryRun });
    if (result.unchanged) {
      console.log(`seed-roles: unchanged (8 built-in roles already current)${dryRun ? " [dry run]" : ""}`);
    } else {
      console.log(
        `seed-roles: roles created=${result.rolesCreated} updated=${result.rolesUpdated}, ` +
          `grants added=${result.grantsAdded} removed=${result.grantsRemoved}` +
          `${dryRun ? " [dry run -- nothing written]" : ""}`,
      );
    }
    if (result.grantsSkippedCustomized.length > 0) {
      console.log(
        `seed-roles: grants left alone for deployment-customised built-in role(s): ` +
          result.grantsSkippedCustomized.join(", "),
      );
    }
    if (result.orphanPermissionKeys.length > 0) {
      console.warn(
        `seed-roles: WARNING -- RolePermission rows name ${result.orphanPermissionKeys.length} ` +
          `permission key(s) the catalog does not declare, so they grant nothing: ` +
          result.orphanPermissionKeys.join(", "),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
