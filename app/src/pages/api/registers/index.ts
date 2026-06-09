// /app/src/pages/api/registers/index.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { getErrorCode } from "@/lib/errorCode";
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
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";
      const storeLocationId = req.query.storeLocationId
        ? Number.parseInt(req.query.storeLocationId as string)
        : undefined;

      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};

      if (storeLocationId) {
        where.storeLocationId = storeLocationId;
      }

      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" as const } },
          { storeLocation: { name: { contains: search, mode: "insensitive" as const } } },
          { storeLocation: { code: { contains: search, mode: "insensitive" as const } } },
        ];
      }

      const [registers, total] = await Promise.all([
        prisma.register.findMany({
          where,
          include: {
            storeLocation: { select: { id: true, name: true, code: true } },
          },
          skip,
          take: limit,
          orderBy: [{ storeLocationId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
        }),
        prisma.register.count({ where }),
      ]);

      return success(res, { registers, total });
    } catch (err) {
      return handleError(res, err, "GET /registers");
    }
  }

  if (req.method === "POST") {
    const { name, storeLocationId } = req.body;
    if (!name?.trim() || !storeLocationId) {
      return badRequest(res, "Name and store location are required");
    }

    try {
      const register = await prisma.register.create({
        data: {
          name: name.trim(),
          storeLocationId: Number.parseInt(storeLocationId),
          createdBy: session.user?.email || null,
        },
        include: {
          storeLocation: { select: { name: true, code: true } },
        },
      });
      return created(res, register);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return conflict(res, `A register named "${name.trim()}" already exists at this location`);
      }
      return handleError(res, err, "POST /registers");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
