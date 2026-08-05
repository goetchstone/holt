// /app/src/lib/auth/requireAuth.ts
//
// API route authentication wrappers.
//
// requireAuth -- checks that the request has a valid session.
// requireAuthWithRole -- additionally checks that the user's StaffMember
//   role is in the allowed list, returning 403 if not. Includes bootstrap
//   safeguard: if no signed-in MANAGER exists, enforcement is skipped so
//   the first user can promote themselves via Admin > Staff.

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession, Session } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { decideRoleAccess } from "@/lib/auth/roleDecision";

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
