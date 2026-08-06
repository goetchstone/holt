// /app/src/lib/auth/roleDecision.ts
//
// Pure authorization decisions, shared by the Pages Router wrappers
// (requireAuthWithRole, requirePermission) and their App Router tRPC
// counterparts (roleProcedure, permissionProcedure) so there is ONE source of
// truth for the rule (CLAUDE.md rules 6 and 42). No I/O — the caller fetches
// the staff role, the staff member's grants, and the privileged-staff count,
// and passes them in.
//
// Two decisions live here, NOT two rule sets. decideRoleAccess answers "is this
// role in the allowed list" and decidePermissionAccess answers "does this role
// hold this capability", but the parts that were actually argued for — how
// impersonation resolves, and when the bootstrap safeguard fires — are one
// implementation (resolveEffectiveRole / applyBootstrapSafeguard) called by
// both. A permission check that quietly re-derived either of those would be a
// regression the type checker could not see.
//
// Rules encoded here:
//   - Impersonation (sh-impersonate cookie) is honored ONLY for a real
//     SUPER_ADMIN or ADMIN, and can only ever REDUCE privilege. An ADMIN used
//     to be able to set the cookie to SUPER_ADMIN and pass a SUPER_ADMIN-gated
//     check, which defeated the whole point of having an owner-only tier above
//     ADMIN. Impersonation exists to see the app as a less-privileged user,
//     never as a more-privileged one.
//   - SUPER_ADMIN auto-satisfies any check that lists ADMIN (strictly more
//     privileged), without ADMIN having to name SUPER_ADMIN explicitly.
//   - Bootstrap safeguard: if the user's effective role isn't allowed, access
//     is still granted WHEN no active privileged user exists yet (so the first
//     user can promote themselves). Once any privileged user exists, deny.

/**
 * Privilege ordering, used ONLY to stop impersonation escalating. Roles not
 * listed rank 0 — they are lateral job functions (DESIGNER, WAREHOUSE,
 * REGISTER, INSTALLER, MARKETING), not rungs on a ladder, so impersonating
 * between them is always allowed and always non-escalating.
 *
 * Deliberately NOT used for the allow-check itself: that stays an explicit
 * list per route, because "MANAGER outranks WAREHOUSE" is not true in any
 * useful sense — they simply do different jobs.
 */
const ROLE_RANK: Record<string, number> = {
  MANAGER: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

/**
 * Resolve the role a check should actually run against, given the real role and
 * whatever the sh-impersonate cookie claims.
 *
 * THE ONE implementation of the anti-escalation rule. Both decideRoleAccess and
 * decidePermissionAccess call it; nothing else may re-derive it.
 *
 * `ranks` overrides the built-in ROLE_RANK table. The permission path passes the
 * ranks read from the Role rows, so a deployment's own role (which the
 * compile-time table has never heard of) participates in the rule instead of
 * ranking 0 and being freely impersonable by anyone who can impersonate at all.
 */
export function resolveEffectiveRole(
  realRole: string,
  impersonate: string | null,
  ranks: Record<string, number> = ROLE_RANK,
): string {
  const canImpersonate = realRole === "SUPER_ADMIN" || realRole === "ADMIN";
  if (!canImpersonate || !impersonate) return realRole;
  // Impersonation must never escalate. An ADMIN impersonating SUPER_ADMIN is
  // just an ADMIN; a SUPER_ADMIN impersonating anyone is that lesser role.
  // Without this, the sh-impersonate cookie is a self-serve privilege upgrade
  // for anyone who already holds ADMIN.
  const escalates = (ranks[impersonate] ?? 0) > (ranks[realRole] ?? 0);
  return escalates ? realRole : impersonate;
}

/**
 * THE ONE implementation of the bootstrap safeguard: a check that would
 * otherwise fail still passes while NO active privileged user exists, so the
 * first user on a fresh deployment can reach Admin > Staff and promote
 * themselves. Once any privileged user exists, deny.
 */
function applyBootstrapSafeguard(privilegedCount: number): {
  allowed: boolean;
  bootstrapBypass: boolean;
} {
  return privilegedCount === 0
    ? { allowed: true, bootstrapBypass: true }
    : { allowed: false, bootstrapBypass: false };
}

export interface RoleDecisionInput {
  /** Allowed roles for the gated resource. */
  allowedRoles: string[];
  /** The user's real role from StaffMember (default "DESIGNER" if unlinked). */
  realRole: string;
  /** Value of the sh-impersonate cookie, or null. */
  impersonate: string | null;
  /**
   * Count of active, linked privileged staff (SUPER_ADMIN/ADMIN/MANAGER).
   * Only consulted when the role check would otherwise fail.
   */
  privilegedCount: number;
}

export interface RoleDecision {
  allowed: boolean;
  /** The role actually used for the check (after impersonation resolution). */
  effectiveUserRole: string;
  /** True when access was granted only because no privileged user exists yet. */
  bootstrapBypass: boolean;
}

export function decideRoleAccess(input: RoleDecisionInput): RoleDecision {
  const { allowedRoles, realRole, impersonate, privilegedCount } = input;

  const effectiveUserRole = resolveEffectiveRole(realRole, impersonate);

  // SUPER_ADMIN satisfies any ADMIN-gated check.
  const effectiveAllowed =
    allowedRoles.includes("ADMIN") && !allowedRoles.includes("SUPER_ADMIN")
      ? [...allowedRoles, "SUPER_ADMIN"]
      : allowedRoles;

  if (effectiveAllowed.includes(effectiveUserRole)) {
    return { allowed: true, effectiveUserRole, bootstrapBypass: false };
  }

  // Not allowed by role — fall back to the bootstrap safeguard.
  return { effectiveUserRole, ...applyBootstrapSafeguard(privilegedCount) };
}

// ---------------------------------------------------------------------------
// Permission-shaped sibling
// ---------------------------------------------------------------------------

export interface PermissionDecisionInput {
  /** The capability the gated resource requires, e.g. "payment.refund". */
  permission: string;
  /** The user's real role KEY — Role.key, or the StaffRole enum value. */
  realRole: string;
  /** Value of the sh-impersonate cookie, or null. */
  impersonate: string | null;
  /**
   * Grants held by each role KEY the decision might land on. The caller
   * supplies at least the real role and, when impersonation is in play, the
   * impersonated one. A key absent from this map holds nothing.
   */
  grantsByRole: Record<string, readonly string[]>;
  /**
   * Role keys that hold EVERY permission, present and future — Role rows with
   * grantsAllPermissions, i.e. the "*" wildcard. Checked before grantsByRole so
   * a permission added by a future release is covered without a row existing
   * for it anywhere.
   */
  wildcardRoles: readonly string[];
  /**
   * Privilege ranks by role key, read from Role rows so a deployment's custom
   * role participates in the anti-escalation rule. Falls back to the built-in
   * table when empty.
   */
  ranks?: Record<string, number>;
  /**
   * Count of active, linked privileged staff (SUPER_ADMIN/ADMIN/MANAGER).
   * Only consulted when the permission check would otherwise fail — pass a
   * lazily-fetched value.
   */
  privilegedCount: number;
}

export interface PermissionDecision {
  allowed: boolean;
  /** The role actually used for the check (after impersonation resolution). */
  effectiveUserRole: string;
  /** True when access was granted only because no privileged user exists yet. */
  bootstrapBypass: boolean;
  /** True when access came from the wildcard rather than an explicit grant. */
  viaWildcard: boolean;
}

/**
 * Does the caller hold `permission`?
 *
 * Same impersonation and bootstrap rules as decideRoleAccess, by construction —
 * both delegate to resolveEffectiveRole and applyBootstrapSafeguard rather than
 * restating them. The only thing that differs is the allow-check itself:
 * capability membership instead of role-list membership.
 *
 * There is deliberately NO "SUPER_ADMIN satisfies an ADMIN gate" special case
 * here. That rule exists because role lists are hand-written and forgetting to
 * name SUPER_ADMIN was a recurring bug; permissions have no such problem —
 * SUPER_ADMIN holds everything through the wildcard, which is stronger and
 * needs no special case.
 */
export function decidePermissionAccess(input: PermissionDecisionInput): PermissionDecision {
  const { permission, realRole, impersonate, grantsByRole, wildcardRoles, privilegedCount } = input;

  const ranks = input.ranks && Object.keys(input.ranks).length > 0 ? input.ranks : ROLE_RANK;
  const effectiveUserRole = resolveEffectiveRole(realRole, impersonate, ranks);

  if (wildcardRoles.includes(effectiveUserRole)) {
    return { allowed: true, effectiveUserRole, bootstrapBypass: false, viaWildcard: true };
  }

  if ((grantsByRole[effectiveUserRole] ?? []).includes(permission)) {
    return { allowed: true, effectiveUserRole, bootstrapBypass: false, viaWildcard: false };
  }

  return { effectiveUserRole, viaWildcard: false, ...applyBootstrapSafeguard(privilegedCount) };
}
