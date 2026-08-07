// /app/src/lib/auth/requireAuth.ts
//
// API route authentication wrappers.
//
// requireAuth -- checks that the request has a valid session.
// requireAuthWithRole -- additionally checks that the user's StaffMember
//   role is in the allowed list, returning 403 if not. Includes bootstrap
//   safeguard: if no signed-in MANAGER exists, enforcement is skipped so
//   the first user can promote themselves via Admin > Staff.
// requirePermission -- the same shape, but gating on a CAPABILITY from
//   lib/auth/permissionCatalog.ts rather than a job title. This is where the
//   335 role-gated routes are headed; today exactly one route uses it (see
//   docs/domains/staff-auth.md for what is and is not enforced).

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession, Session } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { decideRoleAccess } from "@/lib/auth/roleDecision";
import {
  logBootstrapBypass,
  logPermissionDenial,
  resolvePermissionAccess,
} from "@/lib/auth/permissionResolver";

type AuthenticatedHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
) => Promise<void | NextApiResponse>;

export function requireAuth(handler: AuthenticatedHandler) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const session = await getServerSession(req, res, authOptions);

    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    return handler(req, res, session);
  };
}

export function requireAuthWithRole(roles: string[], handler: AuthenticatedHandler) {
  return requireAuth(async (req, res, session) => {
    const userId = (session.user as any)?.id;
    if (!userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // isActive is part of the authorization decision, not just a UI flag.
    // Without it, deactivating a staff member in Admin > Staff removed them
    // from lists but left every API route open to them for as long as their
    // session lived -- offboarding that does not actually revoke anything.
    const staff = await prisma.staffMember.findFirst({
      where: { userId, isActive: true },
      select: { role: true },
    });

    // No ACTIVE staff record => no role. This used to default to "DESIGNER",
    // a real staff role, which meant anyone who could obtain a session at all
    // -- including a customer-portal or unlisted OAuth account -- was treated
    // as staff. Denying here makes staff membership the thing that grants
    // access, rather than merely authenticating.
    if (!staff) {
      // The bootstrap safeguard below still needs a shot: on a brand-new
      // deployment nobody is staff yet, and the first user has to be able to
      // reach Admin > Staff to promote themselves. decideRoleAccess() only
      // grants that when NO active privileged staff exist.
      const anyPrivileged = await prisma.staffMember.count({
        where: {
          role: { in: ["SUPER_ADMIN", "ADMIN", "MANAGER"] },
          isActive: true,
          userId: { not: null },
        },
      });
      if (anyPrivileged > 0) {
        logger.warn("Role check denied: no active StaffMember for user", {
          userId,
          requiredRoles: roles,
        });
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const realRole = staff?.role || "DESIGNER";
    const impersonate = req.cookies?.["sh-impersonate"] || null;

    // Only pay for the privileged-count query when the role check might fail
    // (the bootstrap safeguard is the sole consumer of it).
    const privilegedCount = await prisma.staffMember.count({
      where: {
        role: { in: ["SUPER_ADMIN", "ADMIN", "MANAGER"] },
        isActive: true,
        userId: { not: null },
      },
    });

    // Shared decision (same rule as the App Router tRPC roleProcedure).
    const decision = decideRoleAccess({
      allowedRoles: roles,
      realRole,
      impersonate,
      privilegedCount,
    });

    if (!decision.allowed) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (decision.bootstrapBypass) {
      logger.warn(
        "Bootstrap safeguard triggered: no active admin/manager found, bypassing role check",
        { userId, requiredRoles: roles, userRole: decision.effectiveUserRole },
      );
    }

    return handler(req, res, session);
  });
}

/**
 * Gate a Pages Router API route on a capability instead of a role list.
 *
 *   export default requirePermission("payment.refund", handler);
 *
 * Deliberately the same shape as requireAuthWithRole above so that converting a
 * route is a one-line mechanical edit, and deliberately NOT its own copy of the
 * rules: every decision is made by resolvePermissionAccess, which the tRPC
 * permissionProcedure also calls (CLAUDE.md rule 42 — one shared function on
 * every path, not one per router).
 *
 * The role is resolved from the database per request, never from the JWT: a
 * session's role is stale the moment someone is re-roled and says nothing about
 * isActive. Impersonation and the bootstrap safeguard behave exactly as they do
 * for requireAuthWithRole, because both go through the same pure decision
 * helpers in roleDecision.ts.
 */
export function requirePermission(permission: string, handler: AuthenticatedHandler) {
  return requireAuth(async (req, res, session) => {
    const userId = (session.user as any)?.id;
    if (!userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await resolvePermissionAccess({
      userId,
      permission,
      impersonate: req.cookies?.["sh-impersonate"] || null,
    });

    if (!result.allowed) {
      logPermissionDenial(userId, permission, result);
      return res.status(403).json({ error: "Forbidden" });
    }
    if (result.bootstrapBypass) {
      logBootstrapBypass(userId, permission, result);
    }

    return handler(req, res, session);
  });
}
