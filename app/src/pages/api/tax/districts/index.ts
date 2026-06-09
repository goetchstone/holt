// /app/src/pages/api/tax/districts/index.ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  success,
  created,
  unauthorized,
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
      const districts = await prisma.taxDistrict.findMany({
        orderBy: { shortName: "asc" },
        include: {
          _count: { select: { zipCodes: true, rules: true } },
        },
      });
      return success(res, districts);
    } catch (err) {
      return handleError(res, err, "GET /tax/districts");
    }
  }

  if (req.method === "POST") {
    const { shortName, state, authority, name, reference, glAccountId } = req.body;
    if (!shortName?.trim() || !state?.trim() || !name?.trim()) {
      return badRequest(res, "Short name, state, and name are required");
    }

    try {
      const district = await prisma.taxDistrict.create({
        data: {
          shortName: shortName.trim(),
          state: state.trim(),
          authority: authority?.trim() || null,
          name: name.trim(),
          reference: reference?.trim() || null,
          glAccountId: glAccountId ? Number.parseInt(glAccountId) : null,
        },
      });
      return created(res, district);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002")
        return conflict(res, `District "${shortName}" already exists`);
      return handleError(res, err, "POST /tax/districts");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
