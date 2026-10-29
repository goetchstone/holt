// /app/src/pages/api/tax/exempt-reasons/index.ts

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

// The list serves two screens: Admin → Tax, which manages reasons, and the
// customer screen, whose exemption picker reads it. A route that serves several
// screens takes any of their keys; adding a reason stays an admin setting.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission({ anyOf: ["admin.settings", "customer.read"] }, handleGet)(req, res);
  }
  if (req.method === "POST") {
    return requirePermission("admin.settings", handlePost)(req, res);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function handleGet(_req: NextApiRequest, res: NextApiResponse) {
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

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
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
