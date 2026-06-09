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

    const staff = await prisma.staffMember.findFirst({
      where: { userId },
      select: { role: true },
    });

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
