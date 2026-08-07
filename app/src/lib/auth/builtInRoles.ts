// /app/src/lib/auth/builtInRoles.ts
//
// Reconciles the eight BUILT_IN_ROLES from permissionCatalog.ts into Role and
// RolePermission rows. Idempotent and declarative in the same sense as
// lib/config/applyPreset.ts (CLAUDE.md rule 63): the full diff is computed
// before anything is written, and a second run writes nothing.
//
// WHERE THIS RUNS. Everywhere migrations run, because a database that has the
// tables but no roles is a deployment where nobody can do anything:
//   - docker-entrypoint.sh, immediately after `prisma migrate deploy` — the
//     path every container start takes, including scripts/deploy.sh's one-off
//     migrate container;
//   - scripts/setup.sh, after its own `prisma migrate deploy`, for local dev;
//   - `npm run seed:roles` for anyone who gets there another way (a bare
//     `prisma db push`, a restored dump).
// It is NOT in prisma/seed/demo — that seed only runs when someone asks for
// demo data, and built-in roles are product, not sample content.
//
// WHAT RESEEDING DOES TO A DEPLOYMENT THAT EDITED A BUILT-IN ROLE. Nothing, to
// its grants. Role.grantsCustomized is set the first time a deployment's own
// edit changes a built-in role's grants; from then on this function reconciles
// only the identity fields (name, description, rank, grantsAllPermissions) and
// leaves the grants exactly as the deployment left them. Where the flag is
// false — the overwhelmingly common case, a role nobody has touched — grants
// are reconciled to the shipped definition in full, additions AND removals, so
// a permission introduced by a later release actually reaches the roles that
// should hold it. Roles the deployment invented (isSystem = false) are never
// touched at all.

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  BUILT_IN_ROLES,
  PERMISSION_KEYS,
  permissionsForBuiltInRole,
  stripBaselinePermissions,
} from "@/lib/auth/permissionCatalog";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";

export interface SyncBuiltInRolesResult {
  rolesCreated: number;
  rolesUpdated: number;
  grantsAdded: number;
  grantsRemoved: number;
  /** Built-in roles skipped because the deployment owns their grants. */
  grantsSkippedCustomized: string[];
  /** RolePermission keys present in the database but absent from the catalog. */
  orphanPermissionKeys: string[];
  /** True when nothing at all was written. */
  unchanged: boolean;
}

export interface SyncBuiltInRolesOpts {
  /** Injectable for tests and for scripts that own their own client. */
  prisma?: PrismaClient;
  /** Compute and report the diff; write nothing. */
  dryRun?: boolean;
}

/**
 * RolePermission rows naming a key the catalog no longer declares.
 *
 * The column is TEXT, so Postgres cannot enforce this (see the schema comment
 * on RolePermission.permission for why it is TEXT and not an enum). A key left
 * behind by a rename is a grant of nothing — the holder quietly loses a
 * capability and the row still reads as a grant in the admin UI, which is the
 * failure mode that makes people stop trusting the permission system. Surfaced
 * rather than deleted: deleting someone's grants as a side effect of a deploy
 * is worse than telling them about it.
 */
export async function findOrphanPermissionKeys(
  client: PrismaClient = defaultPrisma,
): Promise<string[]> {
  const rows = await client.rolePermission.findMany({
    select: { permission: true },
    distinct: ["permission"],
  });
  const known = new Set(PERMISSION_KEYS);
  return rows
    .map((r) => r.permission)
    .filter((p) => !known.has(p))
    .sort();
}

export async function syncBuiltInRoles(
  opts: SyncBuiltInRolesOpts = {},
): Promise<SyncBuiltInRolesResult> {
  const client = opts.prisma ?? defaultPrisma;
  const dryRun = opts.dryRun ?? false;

  const result: SyncBuiltInRolesResult = {
    rolesCreated: 0,
    rolesUpdated: 0,
    grantsAdded: 0,
    grantsRemoved: 0,
    grantsSkippedCustomized: [],
    orphanPermissionKeys: [],
    unchanged: true,
  };

  for (const def of BUILT_IN_ROLES) {
    const wantsWildcard = def.permissions === "*";
    const existing = await client.role.findUnique({
      where: { key: def.key },
      select: {
        id: true,
        name: true,
        description: true,
        rank: true,
        grantsAllPermissions: true,
        isSystem: true,
        grantsCustomized: true,
        permissions: { select: { id: true, permission: true } },
      },
    });

    // --- identity ---------------------------------------------------------
    const identity = {
      name: def.name,
      description: def.description,
      rank: def.rank ?? 0,
      grantsAllPermissions: wantsWildcard,
      isSystem: true,
    };

    let roleId: number;
    let currentGrants: { id: number; permission: string }[];
    let grantsCustomized: boolean;

    if (!existing) {
      result.unchanged = false;
      result.rolesCreated++;
      // -1 on a dry run: there is no row to hang grants off, but the grant diff
      // below still has to run so `--dry-run` reports what a real run WOULD
      // write. Nothing reads roleId on that path because every write is skipped.
      roleId = dryRun
        ? -1
        : (await client.role.create({ data: { key: def.key, ...identity }, select: { id: true } }))
            .id;
      currentGrants = [];
      grantsCustomized = false;
    } else {
      roleId = existing.id;
      currentGrants = existing.permissions;
      grantsCustomized = existing.grantsCustomized;

      const identityDrifted =
        existing.name !== identity.name ||
        (existing.description ?? null) !== identity.description ||
        existing.rank !== identity.rank ||
        existing.grantsAllPermissions !== identity.grantsAllPermissions ||
        existing.isSystem !== identity.isSystem;

      if (identityDrifted) {
        result.unchanged = false;
        result.rolesUpdated++;
        if (!dryRun) {
          await client.role.update({ where: { id: roleId }, data: identity });
        }
      }
    }

    // --- grants -----------------------------------------------------------
    // The wildcard is a flag, not rows: SUPER_ADMIN holds every permission
    // including ones a future release adds, and materialising that as 45 rows
    // would freeze it at today's catalog. Any rows it somehow has are stale and
    // get removed.
    // The baseline (staff.self) is likewise a floor, not rows. permissionsFor-
    // BuiltInRole answers "what may this role do", which includes it; what gets
    // STORED is that answer minus the floor. buildRoleGrantTable adds it back to
    // every role at read time, so a stored row would be pure redundancy — and
    // worse, it would read in the admin UI as a grant someone chose and could
    // un-choose, which is the exact failure the implicit baseline prevents.
    const desired = wantsWildcard
      ? []
      : stripBaselinePermissions(permissionsForBuiltInRole(def.key));

    if (grantsCustomized) {
      result.grantsSkippedCustomized.push(def.key);
      continue;
    }

    const have = new Set(currentGrants.map((g) => g.permission));
    const want = new Set(desired);
    const toAdd = desired.filter((p) => !have.has(p));
    const toRemoveIds = currentGrants.filter((g) => !want.has(g.permission)).map((g) => g.id);

    if (toAdd.length === 0 && toRemoveIds.length === 0) continue;
    result.unchanged = false;
    result.grantsAdded += toAdd.length;
    result.grantsRemoved += toRemoveIds.length;
    if (dryRun) continue;

    if (toRemoveIds.length > 0) {
      await client.rolePermission.deleteMany({ where: { id: { in: toRemoveIds } } });
    }
    if (toAdd.length > 0) {
      await client.rolePermission.createMany({
        data: toAdd.map((permission) => ({ roleId, permission })),
        skipDuplicates: true,
      });
    }
  }

  result.orphanPermissionKeys = await findOrphanPermissionKeys(client);
  if (result.orphanPermissionKeys.length > 0) {
    logger.warn("RolePermission rows name permissions the catalog does not declare", {
      keys: result.orphanPermissionKeys,
      hint:
        "a permission was renamed or removed without a paired migration; these grants " +
        "currently authorize nothing. See lib/auth/permissionCatalog.ts.",
    });
  }

  // Any write here changes who can do what. The cache must not hand out the
  // pre-sync table for up to its TTL afterwards.
  if (!dryRun && !result.unchanged) invalidateRoleGrantCache();

  return result;
}
