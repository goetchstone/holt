// /app/src/lib/auth/roleDecision.ts
//
// Pure role-authorization decision, shared by the Pages Router wrapper
// (requireAuthWithRole) and the App Router tRPC roleProcedure so there is ONE
// source of truth for the rule (CLAUDE.md rule 6). No I/O — the caller fetches
// the staff role + privileged-staff count and passes them in.
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

  const canImpersonate = realRole === "SUPER_ADMIN" || realRole === "ADMIN";
  // Impersonation must never escalate. An ADMIN impersonating SUPER_ADMIN is
  // just an ADMIN; a SUPER_ADMIN impersonating anyone is that lesser role.
  // Without this, the sh-impersonate cookie is a self-serve privilege upgrade
  // for anyone who already holds ADMIN.
  const escalates = canImpersonate && impersonate
    ? ROLE_RANK[impersonate] > (ROLE_RANK[realRole] ?? 0)
    : false;
  const effectiveUserRole =
    canImpersonate && impersonate && !escalates ? impersonate : realRole;

  // SUPER_ADMIN satisfies any ADMIN-gated check.
  const effectiveAllowed =
    allowedRoles.includes("ADMIN") && !allowedRoles.includes("SUPER_ADMIN")
      ? [...allowedRoles, "SUPER_ADMIN"]
      : allowedRoles;

  if (effectiveAllowed.includes(effectiveUserRole)) {
    return { allowed: true, effectiveUserRole, bootstrapBypass: false };
  }

  // Not allowed by role — fall back to the bootstrap safeguard.
  if (privilegedCount === 0) {
    return { allowed: true, effectiveUserRole, bootstrapBypass: true };
  }

  return { allowed: false, effectiveUserRole, bootstrapBypass: false };
}
