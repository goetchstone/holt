// /app/src/pages/api/service/settings/statuses.ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import {
  success,
  created,
  badRequest,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") {
    try {
      const statuses = await prisma.serviceCaseStatus.findMany({
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { cases: true } } },
      });
      return success(res, statuses);
    } catch (err) {
      return handleError(res, err, "GET /service/settings/statuses");
    }
  }

  if (req.method === "POST") {
    const { name, isClosed, color, sortOrder } = req.body;
    if (!name?.trim()) return badRequest(res, "Name is required");

    try {
      const status = await prisma.serviceCaseStatus.create({
        data: {
          name: name.trim(),
          isClosed: isClosed ?? false,
          color: color || null,
          sortOrder: sortOrder ?? 0,
          createdBy: session.user?.email || null,
        },
        include: { _count: { select: { cases: true } } },
      });
      return created(res, status);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002")
        return conflict(res, `Status "${name.trim()}" already exists`);
      return handleError(res, err, "POST /service/settings/statuses");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
