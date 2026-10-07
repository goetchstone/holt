// /app/src/lib/auth/permissionResolver.ts
//
// Server-only. THE one place that answers "may this user do X", for every
// surface (CLAUDE.md rule 42: a safety guard is one shared function on every
// path that needs it). requirePermission (Pages Router) and permissionProcedure
// (App Router / tRPC) are thin wrappers over resolvePermissionAccess() below —
// neither re-derives anything, so the two cannot drift. The legacy role-list
// gates (requireAuthWithRole, roleProcedure, requirePage with a roles array)
// share resolveRoleListAccess() the same way.
//
// WHY THE DATABASE AND NOT THE JWT. permissionCatalog.ts's header calls out the
// hand-rolled getServerSession checks that read the role off the session:
// stale after a role change, and blind to isActive. So the staff row — role,
// roleId, isActive — is read per request.
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
// Net round trips per gated request, for either kind of gate: one (the staff
// row), plus a second only when the check FAILS (the privileged count, which
// only the bootstrap safeguard consumes).

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  BUILT_IN_ROLES,
  PERMISSION_KEYS,
  permissionsForBuiltInRole,
  withBaselinePermissions,
} from "@/lib/auth/permissionCatalog";
import {
  decidePermissionAccess,
  decideRoleAccess,
  describeRequirement,
  type PermissionDecision,
  type PermissionRequirement,
  type RoleDecision,
} from "@/lib/auth/roleDecision";

export type { PermissionRequirement } from "@/lib/auth/roleDecision";

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
  /** Capability required, e.g. "payment.refund", or { anyOf: [...] } for a
   *  route that serves several screens (see PermissionRequirement). */
  permission: PermissionRequirement;
  /** Value of the holt-impersonate cookie, or null. */
  impersonate: string | null;
  /** Further keys to answer for the caller, without gating on them (see
   *  `holds`). */
  also?: readonly string[];
  /** Injectable for tests. Defaults to the shared client. */
  prisma?: PrismaClient;
}

export interface PermissionAccessResult extends PermissionDecision {
  /** True when the user has no active StaffMember row at all. */
  noActiveStaff: boolean;
  /** True when grants came from the StaffRole enum because roleId is NULL. */
  viaEnumFallback: boolean;
  /** For each key in `also`: does the caller hold it? */
  holds: Readonly<Record<string, boolean>>;
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

/** What a staff row decides against: its role key, and the grants of the keys
 *  a decision can land on (the real role, and the impersonated one). */
interface GrantContext {
  realRoleKey: string;
  viaEnumFallback: boolean;
  grantsByRole: Record<string, readonly string[]>;
  wildcardRoles: string[];
  ranks: RoleGrantTable["ranks"];
}

function grantContext(
  staff: { role: string; roleId: number | null },
  impersonate: string | null,
  table: RoleGrantTable,
): GrantContext {
  // roleId is the linked Role; when it is NULL (a staff member created by a
  // path that predates the column, or one whose Role was deleted) fall back to
  // the StaffRole enum through the built-in definitions. This is what makes the
  // route sweep adoptable route by route instead of a flag day.
  const linkedKey = staff.roleId != null ? table.keyById[staff.roleId] : undefined;
  const realRoleKey = linkedKey ?? staff.role;

  // Grants for the two keys the decision can land on: the real role, and the
  // impersonated one when there is a cookie. Anything the DB table has not
  // heard of resolves through the built-in definitions, so a database that has
  // been migrated but not yet seeded still authorizes correctly rather than
  // locking the whole deployment out.
  const grantsByRole: Record<string, readonly string[]> = {};
  for (const key of [realRoleKey, impersonate].filter((k): k is string => !!k)) {
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

  return {
    realRoleKey,
    viaEnumFallback: linkedKey === undefined,
    grantsByRole,
    wildcardRoles: [...table.wildcardRoles],
    ranks: table.ranks,
  };
}

/**
 * Which of `keys` the caller holds, beside whatever admitted them: what lets
 * one route serve two audiences (a cost column for those holding "View cost",
 * the same screen without it for the rest) from the same staff read. Decided
 * exactly as a gate is (decidePermissionAccess, same grant table), so under
 * View as a key is held only when the viewed role and the viewer's own role
 * both hold it. One difference: the bootstrap safeguard is never consulted per
 * key. A request it admitted holds every key, as it holds every route; any
 * other request holds a key only by grant. No active staff row holds nothing.
 */
function holdsFor(
  ctx: GrantContext | null,
  impersonate: string | null,
  keys: readonly string[] | undefined,
  bootstrapBypass: boolean,
): Readonly<Record<string, boolean>> {
  const held = (c: GrantContext, key: string) =>
    decidePermissionAccess({
      permission: key,
      realRole: c.realRoleKey,
      impersonate,
      grantsByRole: c.grantsByRole,
      wildcardRoles: c.wildcardRoles,
      ranks: c.ranks,
      privilegedCount: 1,
    }).allowed;

  const holds: Record<string, boolean> = {};
  for (const key of keys ?? []) {
    holds[key] = bootstrapBypass || (ctx !== null && held(ctx, key));
  }
  return holds;
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
    return {
      ...decision,
      noActiveStaff: true,
      viaEnumFallback: false,
      holds: holdsFor(null, null, input.also, decision.bootstrapBypass),
    };
  }

  const ctx = grantContext(staff, input.impersonate, table);
  const viaEnumFallback = ctx.viaEnumFallback;
  const decisionInput = {
    permission: input.permission,
    realRole: ctx.realRoleKey,
    impersonate: input.impersonate,
    grantsByRole: ctx.grantsByRole,
    wildcardRoles: ctx.wildcardRoles,
    ranks: ctx.ranks,
  };
  const holds = (bootstrapBypass: boolean) =>
    holdsFor(ctx, input.impersonate, input.also, bootstrapBypass);

  // decidePermissionAccess only reads privilegedCount when the capability check
  // has already failed, so the happy path passes a non-zero placeholder and
  // never issues the query. On failure we fetch the real count and re-decide —
  // the bootstrap safeguard is the sole consumer either way.
  const decision = decidePermissionAccess({ ...decisionInput, privilegedCount: 1 });
  if (decision.allowed) {
    return { ...decision, noActiveStaff: false, viaEnumFallback, holds: holds(false) };
  }

  const privilegedCount = await countPrivilegedStaff(client);
  const withBootstrap = decidePermissionAccess({ ...decisionInput, privilegedCount });
  return {
    ...withBootstrap,
    noActiveStaff: false,
    viaEnumFallback,
    holds: holds(withBootstrap.bootstrapBypass),
  };
}

/** Shared 403/deny logging so both guards say the same thing in the same shape. */
export function logPermissionDenial(
  userId: string,
  permission: PermissionRequirement,
  result: PermissionAccessResult,
): void {
  logger.warn("Permission check denied", {
    userId,
    permission: describeRequirement(permission),
    effectiveRole: result.effectiveUserRole,
    noActiveStaff: result.noActiveStaff,
    viaEnumFallback: result.viaEnumFallback,
  });
}

// ---------------------------------------------------------------------------
// The role-list decision
// ---------------------------------------------------------------------------

export interface RoleListAccessInput {
  /** Session user id. */
  userId: string;
  /** Allowed StaffRole enum values, e.g. ["MANAGER", "ADMIN"]. */
  allowedRoles: readonly string[];
  /** Value of the holt-impersonate cookie, or null. */
  impersonate: string | null;
  /** Permission keys to answer for the caller, as on resolvePermissionAccess. */
  also?: readonly string[];
  /** Injectable for tests. Defaults to the shared client. */
  prisma?: PrismaClient;
}

export interface RoleListAccessResult extends RoleDecision {
  /** True when the user has no active StaffMember row at all. */
  noActiveStaff: boolean;
  /** For each key in `also`: does the caller hold it? Answered from their
   *  Role's grants, like any permission, though the gate itself read the enum. */
  holds: Readonly<Record<string, boolean>>;
}

/**
 * Is `userId`'s role in `allowedRoles`? The role-list sibling of
 * resolvePermissionAccess, and the one implementation behind
 * requireAuthWithRole, roleProcedure and requirePage's role-list path.
 *
 * Until 2026-10-01 those three each read the staff row themselves, and two had
 * drifted from the third: roleProcedure and requirePage read the row without
 * isActive and defaulted a missing row to DESIGNER. So a deactivated MANAGER
 * kept every MANAGER/ADMIN report and page for as long as their session lived,
 * and any session at all passed a list containing DESIGNER (REPORT_ROLES).
 * The rules, which requireAuthWithRole always had:
 *   - isActive is part of the decision. Deactivating someone revokes access now.
 *   - No ACTIVE staff row means no role. Only the bootstrap safeguard (no active
 *     privileged staff yet) can still admit, so the first user of a new
 *     deployment can reach Admin > Staff and promote themselves; they do so as
 *     DESIGNER, as before.
 *   - The list is matched against the StaffRole ENUM, not Role.key. Role lists
 *     are legacy gates; new gates use permission keys (PERM-01).
 *   - Impersonation only ever reduces (decideRoleAccess).
 *
 * One staff read; the privileged count is read only when the role check fails.
 */
export async function resolveRoleListAccess(
  input: RoleListAccessInput,
): Promise<RoleListAccessResult> {
  const client = input.prisma ?? defaultPrisma;
  const allowedRoles = [...input.allowedRoles];

  const staff = await client.staffMember.findFirst({
    where: { userId: input.userId, isActive: true },
    select: { role: true, roleId: true },
  });

  if (!staff) {
    const privilegedCount = await countPrivilegedStaff(client);
    if (privilegedCount > 0) {
      return {
        allowed: false,
        effectiveUserRole: "",
        bootstrapBypass: false,
        noActiveStaff: true,
        holds: holdsFor(null, null, input.also, false),
      };
    }
    const decision = decideRoleAccess({
      allowedRoles,
      realRole: "DESIGNER",
      impersonate: input.impersonate,
      privilegedCount,
    });
    // With no staff row and nobody privileged, any admission is the safeguard,
    // even one decideRoleAccess reports as a plain match because the list
    // names DESIGNER; it holds every key like any other safeguard admission.
    return {
      ...decision,
      noActiveStaff: true,
      holds: holdsFor(null, null, input.also, decision.allowed),
    };
  }

  // The grant table is read only when a key was asked for (it is cached, but a
  // plain role-list gate has no use for it).
  const ctx = input.also?.length
    ? grantContext(staff, input.impersonate, await getRoleGrantTable(client))
    : null;
  const holds = (bootstrapBypass: boolean) =>
    holdsFor(ctx, input.impersonate, input.also, bootstrapBypass);

  const decide = (privilegedCount: number) =>
    decideRoleAccess({
      allowedRoles,
      realRole: staff.role,
      impersonate: input.impersonate,
      privilegedCount,
    });

  // As in resolvePermissionAccess: the count only matters once the role has
  // missed, so the happy path passes a non-zero placeholder and skips the query.
  const decision = decide(1);
  if (decision.allowed) return { ...decision, noActiveStaff: false, holds: holds(false) };
  const withBootstrap = decide(await countPrivilegedStaff(client));
  return { ...withBootstrap, noActiveStaff: false, holds: holds(withBootstrap.bootstrapBypass) };
}

/** The logging every role-list guard does, in one shape. */
export function logRoleListOutcome(
  userId: string,
  allowedRoles: readonly string[],
  result: RoleListAccessResult,
): void {
  if (!result.allowed && result.noActiveStaff) {
    logger.warn("Role check denied: no active StaffMember for user", {
      userId,
      requiredRoles: allowedRoles,
    });
  }
  if (result.bootstrapBypass) {
    logger.warn(
      "Bootstrap safeguard triggered: no active admin/manager found, bypassing role check",
      { userId, requiredRoles: allowedRoles, userRole: result.effectiveUserRole },
    );
  }
}

// ---------------------------------------------------------------------------
// "What does this person hold" — the DISPLAY question
// ---------------------------------------------------------------------------
//
// resolvePermissionAccess above answers "may this user do X", and it is the only
// thing any guard may ask. The two functions below answer the different, weaker
// question "which capabilities does this user hold", which exists so the NAV can
// decide what is worth putting in a menu (lib/auth/navPermissions.ts).
//
// Nothing on an enforcement path may consume this list. It is snapshotted into
// the session token, so it can be seconds stale and says nothing about isActive
// after it was minted — which is fine for showing a link and disqualifying for
// anything else. Same rule the catalog header states: the grant table is
// authoritative, the token is a display convenience.

/**
 * Expand a role KEY to every permission it holds. Wildcard roles get the whole
 * catalog (which is what makes SUPER_ADMIN see every nav item without a special
 * case anywhere), a key the grant table has not heard of falls back to the
 * built-in definitions, and the baseline floor is unioned in exactly as
 * buildRoleGrantTable does — so a role with no RolePermission rows at all still
 * comes back holding the floor.
 */
export function grantsForRoleKey(table: RoleGrantTable, roleKey: string): string[] {
  if (table.wildcardRoles.includes(roleKey)) return withBaselinePermissions(PERMISSION_KEYS);
  return withBaselinePermissions(table.grantsByRole[roleKey] ?? permissionsForBuiltInRole(roleKey));
}

/**
 * Every permission key a staff row's role holds. The caller supplies the row it
 * already fetched (the NextAuth jwt callback reads one anyway) so this costs no
 * extra staff query — only the grant table, which is cached.
 *
 * An inactive or missing staff row holds NOTHING, not even the baseline: the
 * floor is a floor under a role, and someone who has been deactivated has no
 * role. That matches resolvePermissionAccess, which denies outright when there
 * is no active staff row.
 */
export async function resolveGrantedPermissions(
  staff: { role: string; roleId: number | null; isActive: boolean } | null,
  client: PrismaClient = defaultPrisma,
): Promise<string[]> {
  if (!staff?.isActive) return [];
  const table = await getRoleGrantTable(client);
  const linkedKey = staff.roleId != null ? table.keyById[staff.roleId] : undefined;
  return grantsForRoleKey(table, linkedKey ?? staff.role);
}

/** Shared bootstrap-bypass logging, matching requireAuthWithRole's warning. */
export function logBootstrapBypass(
  userId: string,
  permission: PermissionRequirement,
  result: PermissionAccessResult,
): void {
  logger.warn(
    "Bootstrap safeguard triggered: no active admin/manager found, bypassing permission check",
    { userId, permission: describeRequirement(permission), userRole: result.effectiveUserRole },
  );
}
