// /app/src/pages/api/registers/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { getErrorCode } from "@/lib/errorCode";
import {
  success,
  unauthorized,
  badRequest,
  notFound,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return badRequest(res, "Invalid ID");

  if (req.method === "GET") {
    try {
      const register = await prisma.register.findUnique({
        where: { id },
        include: {
          storeLocation: { select: { name: true, code: true } },
        },
      });
      if (!register) return notFound(res, "Register");
      return success(res, register);
    } catch (err) {
      return handleError(res, err, `GET /registers/${id}`);
    }
  }

  if (req.method === "PUT") {
    const { name, isActive, sortOrder } = req.body;

    try {
      const data: Record<string, unknown> = {
        updatedBy: session.user?.email || null,
      };

      if (name !== undefined) data.name = name.trim();
      if (isActive !== undefined) data.isActive = isActive;
      if (sortOrder !== undefined) data.sortOrder = Number.parseInt(sortOrder);

      const updated = await prisma.register.update({
        where: { id },
        data,
        include: {
          storeLocation: { select: { name: true, code: true } },
        },
      });

      return success(res, updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return conflict(res, "A register with that name already exists at this location");
      }
      if (getErrorCode(err) === "P2025") return notFound(res, "Register");
      return handleError(res, err, `PUT /registers/${id}`);
    }
  }

  if (req.method === "DELETE") {
    try {
      const tillCount = await prisma.till.count({ where: { registerId: id } });
      if (tillCount > 0) {
        return conflict(
          res,
          `Cannot delete: ${tillCount} till${tillCount !== 1 ? "s" : ""} reference this register`,
        );
      }

      await prisma.register.delete({ where: { id } });
      return success(res, { success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return notFound(res, "Register");
      return handleError(res, err, `DELETE /registers/${id}`);
    }
  }

  return methodNotAllowed(res, ["GET", "PUT", "DELETE"]);
}
