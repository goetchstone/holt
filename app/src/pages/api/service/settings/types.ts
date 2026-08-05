// /app/src/pages/api/service/settings/types.ts

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
      const types = await prisma.serviceCaseType.findMany({
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { cases: true } } },
      });
      return success(res, types);
    } catch (err) {
      return handleError(res, err, "GET /service/settings/types");
    }
  }

  if (req.method === "POST") {
    const { name, sortOrder } = req.body;
    if (!name?.trim()) return badRequest(res, "Name is required");

    try {
      const caseType = await prisma.serviceCaseType.create({
        data: {
          name: name.trim(),
          sortOrder: sortOrder ?? 0,
          createdBy: session.user?.email || null,
        },
        include: { _count: { select: { cases: true } } },
      });
      return created(res, caseType);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002")
        return conflict(res, `Type "${name.trim()}" already exists`);
      return handleError(res, err, "POST /service/settings/types");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
