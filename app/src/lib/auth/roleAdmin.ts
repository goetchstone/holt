// /app/src/lib/auth/roleAdmin.ts
//
// The pure half of the custom-role admin API (src/pages/api/admin/roles/*).
// Everything here is I/O-free and unit-testable with plain object literals; the
// two route files shrink to auth, Prisma and error handling (CLAUDE.md rule 14).
//
// It also holds countStaffHolding(), the self-lockout guard, called by PUT and
// by DELETE (rule 42: a guard present on one mutation path and missing on the
// other is no guard at all).
//
// The baseline floor is NOT redeclared here. `staff.self` is vocabulary, and
// permissionCatalog.ts owns the vocabulary (rule 37): this module calls its
// stripBaselinePermissions() on the storage paths and its
// withBaselinePermissions() on the evaluation path, exactly as the seeder and
// the resolver do.
//
// WHY THE LOCKOUT GUARD DOES NOT RE-DERIVE THE PERMISSION CHECK. It asks
// decidePermissionAccess() the same question requirePermission() asks, with the
// same grant table builder, so "who still holds staff.manage after this write"
// cannot answer differently from "may this person manage staff" tomorrow. The
// only two deliberate differences are documented at the call site: no
// impersonation cookie, and privilegedCount is pinned to 1 so the bootstrap
// safeguard cannot mask a real lockout by pretending everyone is allowed.
//
// The wire types below are the shared client/server contract (rule 7). The UI
// imports them with `import type`, which erases at compile time — this module
// itself is server-side (it reads the StaffRole enum off the Prisma client).

import { StaffRole } from "@prisma/client";

import {
  PERMISSIONS,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
  isBaselinePermission,
  isPermissionKey,
  permissionsForBuiltInRole,
  stripBaselinePermissions,
  withBaselinePermissions,
} from "@/lib/auth/permissionCatalog";
import { buildRoleGrantTable, type RoleGrantRow } from "@/lib/auth/permissionResolver";
import { decidePermissionAccess } from "@/lib/auth/roleDecision";

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

export interface RoleSummary {
  id: number;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  grantsAllPermissions: boolean;
  grantsCustomized: boolean;
  rank: number;
  /**
   * How many permissions this role ACTUALLY grants — for a wildcard role that is
   * the whole catalog, not the zero RolePermission rows it stores. Reporting the
   * row count for the Owner would read as "grants nothing" in the admin list,
   * which is the opposite of the truth.
   */
  permissionCount: number;
  /** StaffMember rows linked to this role, active or not — see toRoleSummary. */
  staffCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: string[];
}

export interface CatalogPayload {
  domains: { key: string; label: string; description: string }[];
  permissions: {
    key: string;
    domain: string;
    label: string;
    description: string;
    sensitive: boolean;
  }[];
}

export interface RolesIndexPayload {
  roles: RoleSummary[];
  catalog: CatalogPayload;
  baseline: string[];
}

/**
 * The Prisma `select` that produces a RoleRow. Shared by both route files so
 * the two cannot select different columns and serialize differently — a role
 * that reports `grantsCustomized` on one endpoint and omits it on the other is
 * a bug the type checker would not catch, because the field is optional in
 * neither place and simply absent in one.
 */
export const ROLE_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  isSystem: true,
  grantsAllPermissions: true,
  grantsCustomized: true,
  rank: true,
  permissions: { select: { permission: true } },
} as const;

/** Shape the serializers need from a Role row. Kept structural, not Prisma's
 *  generated type, so the unit tests can build one by hand. */
export interface RoleRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  grantsAllPermissions: boolean;
  grantsCustomized: boolean;
  rank: number;
  permissions: { permission: string }[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Uppercase A-Z, digits and underscore, 2-40 characters. */
export const ROLE_KEY_PATTERN = /^[A-Z0-9_]{2,40}$/;

/**
 * Keys that belong to the built-ins. A deployment role whose key collided with
 * a StaffRole value would be indistinguishable from the built-in of the same
 * name to the enum fallback in permissionResolver (`table.keyById[roleId]` and
 * `staff.role` would disagree about the same string), and the built-in seeder
 * would start reconciling grants the deployment thinks it owns.
 */
const RESERVED_ROLE_KEYS: ReadonlySet<string> = new Set<string>(Object.values(StaffRole));

export function validateRoleKey(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "key is required — a stable identifier such as FLOOR_LEAD" };
  }
  const key = raw.trim();
  if (!ROLE_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      error:
        `"${key}" is not a valid role key. Use 2 to 40 characters, uppercase A-Z, ` +
        "digits and underscore only — for example FLOOR_LEAD.",
    };
  }
  if (RESERVED_ROLE_KEYS.has(key)) {
    return {
      ok: false,
      error:
        `"${key}" is reserved for the built-in role of the same name. Built-in role ` +
        "keys are the StaffRole values that ship with Holt; pick a different key for " +
        "your own role, or edit the built-in instead of recreating it.",
    };
  }
  return { ok: true, value: key };
}

/**
 * Validate an incoming permission list.
 *
 * An unknown key REFUSES THE WHOLE REQUEST and names the key. Dropping it would
 * leave the operator believing they granted a capability nobody holds, and the
 * admin UI would happily redraw the checkbox they ticked — a permission bug
 * nobody discovers until someone hits a 403 they should not have.
 *
 * The baseline is the one exception, and it is removed rather than rejected —
 * the GUI renders `staff.self` as an always-on checkbox and always-on checkboxes
 * get posted back. Stripping happens BEFORE the isPermissionKey check so this
 * stays correct even if a future release stops declaring the floor in
 * PERMISSIONS: erroring on the one key that can never be granted would be a lie.
 */
export function parsePermissionList(raw: unknown, field = "permissions"): Parsed<string[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${field} must be an array of permission keys` };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return { ok: false, error: `${field} must contain permission keys as strings` };
    }
    const key = entry.trim();
    if (key === "") {
      return { ok: false, error: `${field} contains an empty permission key` };
    }
    if (isBaselinePermission(key)) continue;
    if (!isPermissionKey(key)) {
      return {
        ok: false,
        error:
          `Unknown permission: ${key}. No part of this request was applied — a key ` +
          "that is silently dropped is a grant the operator thinks they made.",
      };
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  out.sort();
  return { ok: true, value: out };
}

/** Optional non-negative integer, used for `rank`. */
export function parseOptionalRank(raw: unknown): Parsed<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return { ok: false, error: "rank must be a non-negative integer" };
  }
  return { ok: true, value: raw };
}

/** Required non-empty display name. */
export function parseRoleName(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "name is required and must be a non-empty string" };
  }
  return { ok: true, value: raw.trim() };
}

/** Optional free text; "" and null both clear it. */
export function parseOptionalDescription(raw: unknown): Parsed<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "description must be a string or null" };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * What a role actually grants, baseline excluded.
 *
 * A wildcard role expands to today's whole catalog. That is a presentation
 * decision, not a storage one: `grantsAllPermissions` stays the mechanism (the
 * check short-circuits on it, and it still covers permissions a future release
 * adds), and PUT refuses to edit a wildcard role's permission list rather than
 * writing rows the check never reads.
 */
export function effectivePermissions(role: {
  grantsAllPermissions: boolean;
  permissions: { permission: string }[];
}): string[] {
  const keys = role.grantsAllPermissions
    ? [...PERMISSION_KEYS]
    : role.permissions.map((p) => p.permission);
  return [...new Set(stripBaselinePermissions(keys))].sort();
}

/**
 * `staffCount` counts EVERY linked StaffMember, active or not. It is the number
 * DELETE will make the operator reassign, and an inactive staff member is one
 * reactivation away from silently falling back to the StaffRole enum if their
 * role vanished underneath them.
 */
export function toRoleSummary(row: RoleRow, staffCount: number): RoleSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    grantsAllPermissions: row.grantsAllPermissions,
    grantsCustomized: row.grantsCustomized,
    rank: row.rank,
    permissionCount: effectivePermissions(row).length,
    staffCount,
  };
}

export function toRoleDetail(row: RoleRow, staffCount: number): RoleDetail {
  return { ...toRoleSummary(row, staffCount), permissions: effectivePermissions(row) };
}

export function buildCatalogPayload(): CatalogPayload {
  return {
    domains: PERMISSION_DOMAINS.map((d) => ({
      key: d.key,
      label: d.label,
      description: d.description,
    })),
    permissions: PERMISSIONS.map((p) => ({
      key: p.key,
      domain: p.domain,
      label: p.label,
      description: p.description,
      sensitive: Boolean(p.sensitive),
    })),
  };
}

// ---------------------------------------------------------------------------
// The self-lockout guard
// ---------------------------------------------------------------------------

/** The capability a deployment must never be able to lose entirely. */
export const LOCKOUT_PERMISSION = "staff.manage";

/** The two fields that decide which role a staff member is judged by. */
export interface StaffRoleLink {
  role: string;
  roleId: number | null;
}

/**
 * How many of `staff` hold `permission`, given `roles` as the role table.
 *
 * Pure, so the guard can be asked about a state that does not exist yet: the
 * callers pass the rows they are ABOUT to write. Resolution mirrors
 * resolvePermissionAccess exactly — roleId first, StaffRole enum as the fallback
 * when the link is missing or dangling, wildcard before explicit grants.
 *
 * privilegedCount is pinned to 1 on purpose. The bootstrap safeguard grants
 * every failing check while no privileged staff exist; letting it fire here
 * would report "someone still holds staff.manage" precisely when nobody does.
 */
export function countStaffHolding(
  permission: string,
  staff: readonly StaffRoleLink[],
  roles: readonly RoleGrantRow[],
): number {
  const table = buildRoleGrantTable([...roles]);
  let count = 0;
  for (const member of staff) {
    const linkedKey = member.roleId != null ? table.keyById[member.roleId] : undefined;
    const key = linkedKey ?? member.role;
    const decision = decidePermissionAccess({
      permission,
      realRole: key,
      impersonate: null,
      grantsByRole: {
        [key]: withBaselinePermissions(table.grantsByRole[key] ?? permissionsForBuiltInRole(key)),
      },
      wildcardRoles: table.wildcardRoles,
      ranks: table.ranks,
      privilegedCount: 1,
    });
    if (decision.allowed) count++;
  }
  return count;
}

/** Role rows as they would be after `roleId`'s grants are replaced. */
export function withPermissionsReplaced(
  roles: readonly RoleGrantRow[],
  roleId: number,
  permissions: readonly string[],
): RoleGrantRow[] {
  return roles.map((r) =>
    r.id === roleId ? { ...r, permissions: permissions.map((permission) => ({ permission })) } : r,
  );
}

/** Role rows as they would be after `roleId` is deleted. */
export function withRoleRemoved(roles: readonly RoleGrantRow[], roleId: number): RoleGrantRow[] {
  return roles.filter((r) => r.id !== roleId);
}

/** Staff links as they would be after everyone on `fromRoleId` moves. */
export function withStaffReassigned(
  staff: readonly StaffRoleLink[],
  fromRoleId: number,
  toRoleId: number | null,
): StaffRoleLink[] {
  return staff.map((s) => (s.roleId === fromRoleId ? { ...s, roleId: toRoleId } : s));
}

/**
 * The 409 body for a refused write, in the operator's words. The UI renders
 * `error` verbatim, so it has to say what would be lost and not just that
 * something was.
 */
export function lockoutMessage(action: string): string {
  return (
    `${action} would leave no active staff member able to manage staff and roles ` +
    `(${LOCKOUT_PERMISSION}). Nobody would be able to grant it back, including you. ` +
    "Give another active, signed-in staff member a role holding it first."
  );
}
