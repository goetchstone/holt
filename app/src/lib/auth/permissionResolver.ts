// /app/src/lib/auth/permissionResolver.ts
//
// Server-only. THE one place that answers "may this user do X", for every
// surface (CLAUDE.md rule 42: a safety guard is one shared function on every
// path that needs it). requirePermission (Pages Router) and permissionProcedure
// (App Router / tRPC) are thin wrappers over resolvePermissionAccess() below —
// neither re-derives anything, so the two cannot drift.
//
// WHY THE DATABASE AND NOT THE JWT. permissionCatalog.ts's header calls out the
// hand-rolled getServerSession checks that read the role off the session:
// stale after a role change, and blind to isActive. So the staff row — role,
// roleId, isActive — is read per request, exactly as requireAuthWithRole does.
// That is a lookup by unique-ish index, not the expensive part.
//
// WHAT IS CACHED, AND WHY THAT PART ONLY. The expensive read is the grant
// table: every Role plus its RolePermission rows. It is small, identical for
// every user, and changes only when an operator edits a role — so it is cached
// for ROLE_GRANT_CACHE_TTL_MS with explicit invalidation on write. The staff row
// is deliberately NOT cached: staleness there is the exact security bug the
// catalog header describes (deactivate someone, they keep working). Staleness in
// the grant table for a few seconds is a different and much smaller risk, and
// invalidateRoleGrantCache() collapses it to zero for any change this process
// makes.
//
// Net round trips per gated request: one (the staff row), plus a second only
// when the check FAILS (the privileged count, which only the bootstrap
// safeguard consumes). requireAuthWithRole pays two unconditionally.

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  BUILT_IN_ROLES,
  permissionsForBuiltInRole,
  withBaselinePermissions,
} from "@/lib/auth/permissionCatalog";
import { decidePermissionAccess, type PermissionDecision } from "@/lib/auth/roleDecision";

/**
 * Compile-time privilege floor. A Role row may RAISE a key's rank (that is how
 * a deployment's own "Floor Lead" joins the ladder) but never lower it below
 * what the built-in definitions declare. Lowering would be an escalation hole:
 * set SUPER_ADMIN's rank to 0 in the database and an ADMIN could impersonate
 * up into it. Ranks are merged with max(), never overwritten.
 */
const BUILT_IN_RANKS: Record<string, number> = Object.fromEntries(
  BUILT_IN_ROLES.filter((r) => r.rank !== undefined).map((r) => [r.key, r.rank as number]),
);

const BUILT_IN_WILDCARD_KEYS: readonly string[] = BUILT_IN_ROLES.filter(
  (r) => r.permissions === "*",
).map((r) => r.key);

// ---------------------------------------------------------------------------
// The grant table
// ---------------------------------------------------------------------------

/** Shape this module needs from a Role row. Kept minimal so the builder below
 *  is unit-testable with plain object literals — no Prisma, no DB. */
export interface RoleGrantRow {
  id: number;
  key: string;
  rank: number;
  grantsAllPermissions: boolean;
  permissions: { permission: string }[];
}

export interface RoleGrantTable {
  /** Permission keys held, by Role.key — RolePermission rows PLUS the baseline. */
  grantsByRole: Record<string, readonly string[]>;
  /** Role keys holding every permission present and future (the "*" wildcard). */
  wildcardRoles: readonly string[];
  /** Anti-escalation ranks by Role.key, floored at the built-in values. */
  ranks: Record<string, number>;
  /** Role.key by Role.id, for resolving StaffMember.roleId. */
  keyById: Record<number, string>;
  /** True when the Role table is empty — a database migrated but never seeded. */
  empty: boolean;
}

/**
 * Pure: turn already-fetched Role rows into the lookup the decision needs.
 *
 * THE place the baseline floor is applied to database-sourced roles. Every
 * row's grants are unioned with BASELINE_PERMISSIONS here — not per call site,
 * not in the GUI, not in the seeder — so a role with zero RolePermission rows,
 * a role a deployment invented last Tuesday, and a role key the catalog has
 * never heard of all hold the floor identically. That is what lets the admin
 * GUI omit `staff.self` from its checkboxes without anyone having to remember
 * to re-add it: there is no path from a Role row to a decision that does not
 * come through this function. See permissionCatalog.ts's BASELINE_PERMISSIONS
 * for why the floor is implicit rather than a checkbox.
 */
export function buildRoleGrantTable(rows: RoleGrantRow[]): RoleGrantTable {
  const grantsByRole: Record<string, readonly string[]> = {};
  const wildcardRoles: string[] = [...BUILT_IN_WILDCARD_KEYS];
  const ranks: Record<string, number> = { ...BUILT_IN_RANKS };
  const keyById: Record<number, string> = {};

  for (const row of rows) {
    keyById[row.id] = row.key;
    grantsByRole[row.key] = withBaselinePermissions(row.permissions.map((p) => p.permission));
    if (row.grantsAllPermissions && !wildcardRoles.includes(row.key)) wildcardRoles.push(row.key);
    ranks[row.key] = Math.max(ranks[row.key] ?? 0, row.rank);
  }

  return { grantsByRole, wildcardRoles, ranks, keyById, empty: rows.length === 0 };
}

// 30s. The grant table is read on every gated request, so a per-request query
// would put a join against RolePermission on the hot path of every route the
// sweep eventually touches. A process-lifetime singleton is the other extreme:
// an operator who revokes payment.refund would keep granting it until the next
// deploy, which is a security bug, not an inconvenience. 30s is the window in
// which a change made by ANOTHER process (a second container, a psql session,
// the seeder in a one-off migrate container) becomes visible here;
// invalidateRoleGrantCache() below makes any change made by THIS process
// visible immediately, and every in-app write path calls it.
export const ROLE_GRANT_CACHE_TTL_MS = 30_000;

let cached: { table: RoleGrantTable; expiresAt: number } | null = null;

// Bumped by invalidateRoleGrantCache(). Without it, a load already in flight
// when an invalidation happens can resolve AFTER it and reinstall the stale
// table for a full fresh TTL — silently undoing the invalidation it raced with.
// Same pattern, and the same reason, as lib/trafficStoreMap.ts.
let generation = 0;

export async function getRoleGrantTable(
  client: PrismaClient = defaultPrisma,
): Promise<RoleGrantTable> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) return cached.table;

  const startedAtGeneration = generation;
  const rows = await client.role.findMany({
    select: {
      id: true,
      key: true,
      rank: true,
      grantsAllPermissions: true,
      permissions: { select: { permission: true } },
    },
  });
  const table = buildRoleGrantTable(rows);
  if (generation === startedAtGeneration) {
    cached = { table, expiresAt: Date.now() + ROLE_GRANT_CACHE_TTL_MS };
  }
  return table;
}

/**
 * Drop the cached grant table. MUST be called by every path that writes Role or
 * RolePermission — the built-in role seeder, the (future) custom-role admin
 * GUI, a config-preset apply that carries roles. A revocation that takes up to
 * 30s to bite is a security bug; this is what makes it immediate.
 */
export function invalidateRoleGrantCache(): void {
  generation++;
  cached = null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface PermissionAccessInput {
  /** Session user id. */
  userId: string;
  /** Capability required, e.g. "payment.refund". */
  permission: string;
  /** Value of the sh-impersonate cookie, or null. */
  impersonate: string | null;
  /** Injectable for tests. Defaults to the shared client. */
  prisma?: PrismaClient;
}

export interface PermissionAccessResult extends PermissionDecision {
  /** True when the user has no active StaffMember row at all. */
  noActiveStaff: boolean;
  /** True when grants came from the StaffRole enum because roleId is NULL. */
  viaEnumFallback: boolean;
}

/** Count of active, linked privileged staff. Only the bootstrap safeguard reads
 *  it, so it is fetched lazily — after the permission check has already failed. */
async function countPrivilegedStaff(client: PrismaClient): Promise<number> {
  return client.staffMember.count({
    where: {
      role: { in: ["SUPER_ADMIN", "ADMIN", "MANAGER"] },
      isActive: true,
      userId: { not: null },
    },
  });
}

/**
 * Does `userId` hold `permission`? Everything the guards need, in one call.
 *
 * The rules preserved from requireAuthWithRole, deliberately and in the same
 * order:
 *   - isActive is part of the decision, not a UI flag. Deactivating someone
 *     revokes access immediately rather than at session expiry.
 *   - No ACTIVE staff row means no role — NOT a default of DESIGNER, which used
 *     to make any session-holder staff.
 *   - Impersonation is honoured only for a real SUPER_ADMIN/ADMIN and only ever
 *     reduces privilege (resolveEffectiveRole, shared with decideRoleAccess).
 *   - The bootstrap safeguard still applies when no privileged user exists yet.
 */
export async function resolvePermissionAccess(
  input: PermissionAccessInput,
): Promise<PermissionAccessResult> {
  const client = input.prisma ?? defaultPrisma;

  const staff = await client.staffMember.findFirst({
    where: { userId: input.userId, isActive: true },
    select: { role: true, roleId: true },
  });

  const table = await getRoleGrantTable(client);

  // No active staff row: nothing is granted, and only the bootstrap safeguard
  // can still let this through.
  if (!staff) {
    const privilegedCount = await countPrivilegedStaff(client);
    const decision = decidePermissionAccess({
      permission: input.permission,
      realRole: "",
      impersonate: null,
      grantsByRole: {},
      wildcardRoles: [],
      ranks: table.ranks,
      privilegedCount,
    });
    return { ...decision, noActiveStaff: true, viaEnumFallback: false };
  }

  // roleId is the linked Role; when it is NULL (a staff member created by a
  // path that predates the column, or one whose Role was deleted) fall back to
  // the StaffRole enum through the built-in definitions. This is what makes the
  // route sweep adoptable route by route instead of a flag day.
  const linkedKey = staff.roleId != null ? table.keyById[staff.roleId] : undefined;
  const realRoleKey = linkedKey ?? staff.role;
  const viaEnumFallback = linkedKey === undefined;

  // Grants for the two keys the decision can land on: the real role, and the
  // impersonated one when there is a cookie. Anything the DB table has not
  // heard of resolves through the built-in definitions, so a database that has
  // been migrated but not yet seeded still authorizes correctly rather than
  // locking the whole deployment out.
  const grantsByRole: Record<string, readonly string[]> = {};
  const wildcardRoles = [...table.wildcardRoles];
  for (const key of [realRoleKey, input.impersonate].filter((k): k is string => !!k)) {
    if (key in grantsByRole) continue;
    // Both sources already carry the baseline (buildRoleGrantTable unions it in,
    // permissionsForBuiltInRole returns it even for a key it does not know). The
    // union is repeated here anyway because this is the one line where a role
    // KEY becomes a grant list: making it total here means the floor survives a
    // future edit to either source, rather than depending on both staying right.
    grantsByRole[key] = withBaselinePermissions(
      table.grantsByRole[key] ?? permissionsForBuiltInRole(key),
    );
  }

  const decisionInput = {
    permission: input.permission,
    realRole: realRoleKey,
    impersonate: input.impersonate,
    grantsByRole,
    wildcardRoles,
    ranks: table.ranks,
  };

  // decidePermissionAccess only reads privilegedCount when the capability check
  // has already failed, so the happy path passes a non-zero placeholder and
  // never issues the query. On failure we fetch the real count and re-decide —
  // the bootstrap safeguard is the sole consumer either way.
  const decision = decidePermissionAccess({ ...decisionInput, privilegedCount: 1 });
  if (decision.allowed) return { ...decision, noActiveStaff: false, viaEnumFallback };

  const privilegedCount = await countPrivilegedStaff(client);
  const withBootstrap = decidePermissionAccess({ ...decisionInput, privilegedCount });
  return { ...withBootstrap, noActiveStaff: false, viaEnumFallback };
}

/** Shared 403/deny logging so both guards say the same thing in the same shape. */
export function logPermissionDenial(
  userId: string,
  permission: string,
  result: PermissionAccessResult,
): void {
  logger.warn("Permission check denied", {
    userId,
    permission,
    effectiveRole: result.effectiveUserRole,
    noActiveStaff: result.noActiveStaff,
    viaEnumFallback: result.viaEnumFallback,
  });
}

/** Shared bootstrap-bypass logging, matching requireAuthWithRole's warning. */
export function logBootstrapBypass(
  userId: string,
  permission: string,
  result: PermissionAccessResult,
): void {
  logger.warn(
    "Bootstrap safeguard triggered: no active admin/manager found, bypassing permission check",
    { userId, permission, userRole: result.effectiveUserRole },
  );
}
