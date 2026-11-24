// /app/src/pages/api/service/settings/types.ts
//
// The service-case types. The list (GET) fills the Service queue's filter
// ("View service"), New case's picker ("Work service") and Settings > Service
// ("Manage configuration"), so any of those keys reads it, as does "Set up
// service". Adding a type (POST) is setup: "Set up service" (service.setup),
// or "Manage configuration", the key Settings > Service opens on. The status
// and priority lists beside this one are gated the same way.

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
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
      // Wrapped: Service Settings, the new-case form and the service list all
      // read `.types`. A bare list showed none of them (2026-11-01).
      return success(res, { types });
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

const readGate = requirePermission(
  { anyOf: ["service.read", "service.write", "service.setup", "admin.config"] },
  handler,
);
const writeGate = requirePermission({ anyOf: ["service.setup", "admin.config"] }, handler);

export default async function route(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return readGate(req, res);
  return writeGate(req, res);
}
