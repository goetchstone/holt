// /app/src/pages/api/service/settings/types/[id].ts

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
    const { name, isActive, sortOrder } = req.body;

    try {
      const caseType = await prisma.serviceCaseType.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(isActive !== undefined && { isActive }),
          ...(sortOrder !== undefined && { sortOrder }),
          updatedBy: session.user?.email || null,
        },
        include: { _count: { select: { cases: true } } },
      });
      return success(res, caseType);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return notFound(res, "Type");
      if (getErrorCode(err) === "P2002")
        return conflict(res, `Type "${name?.trim()}" already exists`);
      return handleError(res, err, "PUT /service/settings/types/[id]");
    }
  }

  if (req.method === "DELETE") {
    try {
      const caseCount = await prisma.serviceCase.count({ where: { typeId: id } });
      if (caseCount > 0) {
        return conflict(res, `Cannot delete type: ${caseCount} case(s) reference it`);
      }

      await prisma.serviceCaseType.delete({ where: { id } });
      return noContent(res);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return notFound(res, "Type");
      return handleError(res, err, "DELETE /service/settings/types/[id]");
    }
  }

  return methodNotAllowed(res, ["PUT", "DELETE"]);
}
