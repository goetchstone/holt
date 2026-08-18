// /app/src/pages/api/interactions/active.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { success, unauthorized, notFound, methodNotAllowed, handleError } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  // requirePermission guarantees a session and an active staff row; it does NOT
  // guarantee an email, which is this route's StaffMember lookup key.
  if (!session.user?.email) return unauthorized(res);

  try {
    const staffMember = await prisma.staffMember.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    });

    if (!staffMember) return notFound(res, "Staff member");

    const interactions = await prisma.customerInteraction.findMany({
      where: {
        staffMemberId: staffMember.id,
        isActive: true,
      },
      orderBy: { startedAt: "desc" },
      include: {
        staffMember: { select: { id: true, displayName: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
        salesOrder: { select: { id: true, orderno: true } },
      },
    });

    return success(res, interactions);
  } catch (err) {
    return handleError(res, err, "GET /interactions/active");
  }
}

// Self-service: this returns only the caller's OWN open interactions (the
// up-board's "with customer" state), the same rows upboard/action.ts writes,
// which is `staff.self` — the baseline every staff role holds. Listing OTHER
// people's interactions is /api/interactions, which is gated separately.
export default requirePermission("staff.self", handler);
