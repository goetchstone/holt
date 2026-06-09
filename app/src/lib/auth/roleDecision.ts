// /app/src/lib/auth/roleDecision.ts
//
// Pure role-authorization decision, shared by the Pages Router wrapper
// (requireAuthWithRole) and the App Router tRPC roleProcedure so there is ONE
// source of truth for the rule (CLAUDE.md rule 6). No I/O — the caller fetches
// the staff role + privileged-staff count and passes them in.
//
// Rules encoded here:
//   - Impersonation (sh-impersonate cookie) is honored ONLY for a real
//     SUPER_ADMIN or ADMIN; everyone else's impersonation value is ignored.
//   - SUPER_ADMIN auto-satisfies any check that lists ADMIN (strictly more
//     privileged), without ADMIN having to name SUPER_ADMIN explicitly.
//   - Bootstrap safeguard: if the user's effective role isn't allowed, access
//     is still granted WHEN no active privileged user exists yet (so the first
//     user can promote themselves). Once any privileged user exists, deny.

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
  const effectiveUserRole = canImpersonate && impersonate ? impersonate : realRole;

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
