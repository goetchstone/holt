// /app/src/pages/api/staff/active-store.ts
//
// GET: returns the current user's active store location
// PUT: sets the current user's active store location

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, methodNotAllowed, success } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const email = session.user?.email;
  if (!email) return badRequest(res, "No email in session");

  const staff = await prisma.staffMember.findFirst({
    where: { email },
    include: {
      activeStoreLocation: { select: { id: true, name: true, code: true, type: true } },
    },
  });

  if (!staff) return notFound(res, "Staff member");

  if (req.method === "GET") {
    return success(res, {
      activeStoreLocation: staff.activeStoreLocation,
      staffId: staff.id,
      displayName: staff.displayName,
    });
  }

  if (req.method === "PUT") {
    const { storeLocationId } = req.body;
    if (!storeLocationId) return badRequest(res, "storeLocationId is required");

    const store = await prisma.storeLocation.findUnique({
      where: { id: Number.parseInt(storeLocationId) },
      select: { id: true, name: true, code: true, type: true },
    });

    if (!store) return notFound(res, "Store location");

    await prisma.staffMember.update({
      where: { id: staff.id },
      data: { activeStoreLocationId: store.id },
    });

    return success(res, { activeStoreLocation: store });
  }

  return methodNotAllowed(res, ["GET", "PUT"]);
}

// Self-service: every staff role sets their own active store location.
export default requirePermission("staff.self", handler);
