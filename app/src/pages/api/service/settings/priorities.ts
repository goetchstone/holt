// /app/src/pages/api/service/settings/priorities.ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  success,
  created,
  unauthorized,
  forbidden,
  badRequest,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  if (req.method === "GET") {
    try {
      const priorities = await prisma.serviceCasePriority.findMany({
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { cases: true } } },
      });
      return success(res, priorities);
    } catch (err) {
      return handleError(res, err, "GET /service/settings/priorities");
    }
  }

  if (req.method === "POST") {
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") return forbidden(res, "Manager role required");

    const { name, level, color, sortOrder } = req.body;
    if (!name?.trim()) return badRequest(res, "Name is required");

    try {
      const priority = await prisma.serviceCasePriority.create({
        data: {
          name: name.trim(),
          level: level ?? 0,
          color: color || null,
          sortOrder: sortOrder ?? 0,
          createdBy: session.user?.email || null,
        },
        include: { _count: { select: { cases: true } } },
      });
      return created(res, priority);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002")
        return conflict(res, `Priority "${name.trim()}" already exists`);
      return handleError(res, err, "POST /service/settings/priorities");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
