// /app/src/pages/api/service/settings/priorities/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  success,
  noContent,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  const role = (session as any)?.role;
  if (role !== "MANAGER" && role !== "ADMIN") return forbidden(res, "Manager role required");

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return badRequest(res, "Invalid ID");

  if (req.method === "PUT") {
    const { name, level, color, isActive, sortOrder } = req.body;

    try {
      const priority = await prisma.serviceCasePriority.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(level !== undefined && { level }),
          ...(color !== undefined && { color }),
          ...(isActive !== undefined && { isActive }),
          ...(sortOrder !== undefined && { sortOrder }),
          updatedBy: session.user?.email || null,
        },
        include: { _count: { select: { cases: true } } },
      });
      return success(res, priority);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return notFound(res, "Priority");
      if (getErrorCode(err) === "P2002")
        return conflict(res, `Priority "${name?.trim()}" already exists`);
      return handleError(res, err, "PUT /service/settings/priorities/[id]");
    }
  }

  if (req.method === "DELETE") {
    try {
      const caseCount = await prisma.serviceCase.count({ where: { priorityId: id } });
      if (caseCount > 0) {
        return conflict(res, `Cannot delete priority: ${caseCount} case(s) reference it`);
      }

      await prisma.serviceCasePriority.delete({ where: { id } });
      return noContent(res);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return notFound(res, "Priority");
      return handleError(res, err, "DELETE /service/settings/priorities/[id]");
    }
  }

  return methodNotAllowed(res, ["PUT", "DELETE"]);
}
