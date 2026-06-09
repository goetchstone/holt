// /app/src/pages/api/interactions/active.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { success, unauthorized, notFound, methodNotAllowed, handleError } from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return unauthorized(res);

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
