// /app/src/pages/api/staff/active-store.ts
//
// GET: returns the current user's active store location
// PUT: sets the current user's active store location

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { success, unauthorized, badRequest, notFound, methodNotAllowed } from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

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
