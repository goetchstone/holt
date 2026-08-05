// /app/src/pages/api/tax/exempt-reasons/index.ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import {
  success,
  created,
  badRequest,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    try {
      const reasons = await prisma.taxExemptReason.findMany({
        orderBy: { name: "asc" },
        include: {
          _count: { select: { customers: true } },
        },
      });
      return success(res, reasons);
    } catch (err) {
      return handleError(res, err, "GET /tax/exempt-reasons");
    }
  }

  if (req.method === "POST") {
    const { name, description } = req.body;
    if (!name?.trim()) return badRequest(res, "Name is required");

    try {
      const reason = await prisma.taxExemptReason.create({
        data: {
          name: name.trim(),
          description: description?.trim() || null,
        },
      });
      return created(res, reason);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002")
        return conflict(res, `Exempt reason "${name}" already exists`);
      return handleError(res, err, "POST /tax/exempt-reasons");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requireAuthWithRole(["ADMIN"], handler);
