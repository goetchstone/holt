// /app/src/app/(dashboard)/app/admin/setup/roles/rolesModel.ts
//
// The Roles admin GUI's shape of the /api/admin/roles contract, plus the pure
// helpers the view renders from. Co-located with the view for the same reason
// configuration/configClient.ts is co-located with its panels: nothing outside
// this page consumes it.
//
// CLAUDE.md rule 14 — the branching lives here, not in JSX. Every function
// below is a pure transform over already-fetched data, so __tests__/
// rolesAdminModel.test.ts can assert the behaviour without a DOM or a server.
//
// CONTRACT (rule 7). The wire types are NOT redeclared here. They come from
// lib/auth/roleAdmin.ts, the same module the two route files serialize with, so
// a field this page reads and the API stops sending is a compile error rather
// than a runtime 400. `import type` erases at compile time, which is what lets a
// client component reference a server-side module (roleAdmin reads the StaffRole
// enum off the Prisma client) without pulling any of it into the browser bundle.

import type {
  CatalogPayload,
  RoleDetail,
  RolesIndexPayload,
  RoleSummary,
} from "@/lib/auth/roleAdmin";

export type { CatalogPayload, RoleDetail, RolesIndexPayload, RoleSummary };

/** The element types of the catalog payload, which it declares inline. */
export type CatalogDomain = CatalogPayload["domains"][number];
export type CatalogPermission = CatalogPayload["permissions"][number];

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Derive a Role.key from the operator-facing name.
 *
 * The key is permanent (PUT refuses to change it) and is never shown as an
 * input: asking a store owner to invent a stable identifier alongside a name is
 * the kind of second field that makes a form feel like a database. Matches the
 * built-ins' shape — SCREAMING_SNAKE — so "Floor Lead" reads next to "MANAGER"
 * rather than beside it.
 */
export function deriveRoleKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .slice(0, 40)
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// The grant grid
// ---------------------------------------------------------------------------

export interface GrantDomainGroup {
  key: string;
  label: string;
  description: string;
  permissions: CatalogPermission[];
}

/**
 * The catalog, grouped for display: domains in catalog order, baseline keys
 * removed (they are stated as fact elsewhere, not offered as a checkbox).
 *
 * A permission whose domain the payload never declares still gets a group of
 * its own, labelled with the raw domain key. Dropping it would make a
 * capability that exists and is enforced invisible and un-grantable here — the
 * failure mode a permissions UI cannot have.
 */
export function groupGrantsByDomain(
  catalog: CatalogPayload,
  baseline: string[],
): GrantDomainGroup[] {
  const floor = new Set(baseline);
  const byDomain = new Map<string, CatalogPermission[]>();
  for (const perm of catalog.permissions) {
    if (floor.has(perm.key)) continue;
    const list = byDomain.get(perm.domain);
    if (list) list.push(perm);
    else byDomain.set(perm.domain, [perm]);
  }

  const groups: GrantDomainGroup[] = [];
  const declared = new Set<string>();
  for (const domain of catalog.domains) {
    declared.add(domain.key);
    const permissions = byDomain.get(domain.key);
    if (!permissions || permissions.length === 0) continue;
    groups.push({
      key: domain.key,
      label: domain.label,
      description: domain.description,
      permissions,
    });
  }
  for (const [key, permissions] of byDomain) {
    if (declared.has(key)) continue;
    groups.push({ key, label: key, description: "", permissions });
  }
  return groups;
}

export interface BaselineEntry {
  key: string;
  label: string;
  description: string;
}

/**
 * The floor, described in the catalog's own words where the catalog knows the
 * key and by the raw key where it does not — a baseline permission the catalog
 * has not caught up with is still true of every role, so it is still shown.
 */
export function baselineEntries(catalog: CatalogPayload, baseline: string[]): BaselineEntry[] {
  const byKey = new Map(catalog.permissions.map((p) => [p.key, p]));
  return baseline.map((key) => {
    const def = byKey.get(key);
    return { key, label: def?.label ?? key, description: def?.description ?? "" };
  });
}

// ---------------------------------------------------------------------------
// Grants in and out
// ---------------------------------------------------------------------------

/**
 * What this page sends as `permissions`: deduped, sorted, and with the baseline
 * stripped. The API ignores baseline keys silently either way; not sending them
 * keeps the request honest about what it is asking to change.
 */
export function sanitizeGrants(keys: Iterable<string>, baseline: string[]): string[] {
  const floor = new Set(baseline);
  return [...new Set(keys)].filter((key) => !floor.has(key)).sort((a, b) => a.localeCompare(b));
}

/**
 * The grants a new role starts with when cloned from `source`.
 *
 * A wildcard role holds every permission present AND future via a flag, not via
 * rows, so its `permissions` array is empty. Copying it literally would produce
 * a role that can do nothing — the opposite of what "start from Owner" means —
 * so the wildcard is expanded against the catalog here.
 */
export function clonedGrants(
  source: Pick<RoleDetail, "permissions" | "grantsAllPermissions">,
  catalog: CatalogPayload,
  baseline: string[],
): string[] {
  const keys = source.grantsAllPermissions
    ? catalog.permissions.map((p) => p.key)
    : source.permissions;
  return sanitizeGrants(keys, baseline);
}

export interface GrantDiff {
  added: string[];
  removed: string[];
}

export function grantDiff(original: string[], next: string[]): GrantDiff {
  const before = new Set(original);
  const after = new Set(next);
  return {
    added: next.filter((key) => !before.has(key)),
    removed: original.filter((key) => !after.has(key)),
  };
}

/** Catalog defs for a set of keys, in catalog order. Unknown keys are dropped. */
export function describeGrants(keys: string[], catalog: CatalogPayload): CatalogPermission[] {
  const wanted = new Set(keys);
  return catalog.permissions.filter((p) => wanted.has(p.key));
}

export function sensitiveGrants(keys: string[], catalog: CatalogPayload): CatalogPermission[] {
  return describeGrants(keys, catalog).filter((p) => p.sensitive);
}

// ---------------------------------------------------------------------------
// Deleting a role
// ---------------------------------------------------------------------------

export function staffCountPhrase(count: number): string {
  return `${count} staff member${count === 1 ? "" : "s"}`;
}

/** The sentence above the reassignment picker. Says where people end up. */
export function reassignSentence(staffCount: number, targetName: string | null): string {
  if (staffCount === 0) return "Nobody holds this role, so no one has to move.";
  const verb = staffCount === 1 ? "holds" : "hold";
  if (!targetName) {
    return `${staffCountPhrase(staffCount)} ${verb} this role. Choose where they go before deleting it.`;
  }
  return `${staffCountPhrase(staffCount)} ${verb} this role and will move to ${targetName}.`;
}

/**
 * Why the delete button is not armed yet, or null when it is. A mirror of the
 * server's refusals for the two it can know locally, so the operator is told
 * before the round trip — NOT a replacement for them. The server is the guard
 * (CLAUDE.md rule 42); this is a label.
 */
export function deleteBlockedReason(
  role: Pick<RoleSummary, "id" | "isSystem" | "staffCount">,
  reassignToRoleId: number | null,
): string | null {
  if (role.isSystem) {
    return "Roles that ship with holt cannot be deleted. A deployment that could delete Administrator could lock itself out of its own installation.";
  }
  if (reassignToRoleId === role.id) {
    return "Staff cannot be moved to the role being deleted.";
  }
  if (role.staffCount > 0 && reassignToRoleId == null) {
    return "Choose the role these staff move to.";
  }
  return null;
}

/** Roles a delete may move staff into: everything except the one being deleted. */
export function reassignTargets(roles: RoleSummary[], roleId: number): RoleSummary[] {
  return roles.filter((role) => role.id !== roleId);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * HTTP status off an axios-shaped error, or null. Kept axios-free so this module
 * stays a pure data transform.
 *
 * 409 is the interesting one: the roles API answers a refused write with a
 * plain-language explanation of what would break ("that would leave no one who
 * can manage staff"). Those are pinned in the UI rather than toasted, because a
 * sentence explaining a lockout is not something to read in four seconds.
 */
export function responseStatus(err: unknown): number | null {
  const status = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return typeof status === "number" ? status : null;
}

export function isRefusal(err: unknown): boolean {
  return responseStatus(err) === 409;
}
