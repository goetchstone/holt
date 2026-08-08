// /app/src/pages/api/tax/groups/index.ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
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
      const groups = await prisma.taxGroup.findMany({
        orderBy: { name: "asc" },
        include: {
          _count: { select: { rules: true } },
        },
      });
      return success(res, groups);
    } catch (err) {
      return handleError(res, err, "GET /tax/groups");
    }
  }

  if (req.method === "POST") {
    const { name, taxBasis, freightTaxable, miscTaxable } = req.body;
    if (!name?.trim()) return badRequest(res, "Name is required");

    try {
      const group = await prisma.taxGroup.create({
        data: {
          name: name.trim(),
          taxBasis: taxBasis || "NET",
          freightTaxable: !!freightTaxable,
          miscTaxable: !!miscTaxable,
        },
      });
      return created(res, group);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") return conflict(res, `Tax group "${name}" already exists`);
      return handleError(res, err, "POST /tax/groups");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requirePermission("admin.settings", handler);
