// /app/src/pages/api/registers/index.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { getErrorCode } from "@/lib/errorCode";
import { isPracticeCopy } from "@/lib/practiceCopy";
import {
  success,
  created,
  badRequest,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

/**
 * A register as the list answers it: whether it has a till open and a card
 * reader, in place of the rows those were read from. A practice copy reaches no
 * card processor, so none of its registers has a reader to send to (as
 * registers/[id].ts answers).
 */
function withWhatItHas<
  R extends { tills: { id: number }[]; cardReader: { isActive: boolean } | null },
>({ tills, cardReader, ...register }: R) {
  return {
    ...register,
    hasOpenTill: tills.length > 0,
    hasCardReader: cardReader?.isActive === true && !isPracticeCopy(),
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
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

      const [rows, total] = await Promise.all([
        prisma.register.findMany({
          where,
          include: {
            storeLocation: { select: { id: true, name: true, code: true } },
            // For choosing a register to take a payment at: which have a till
            // open, and which have a card reader.
            tills: { where: { status: "OPEN" }, take: 1, select: { id: true } },
            cardReader: { select: { isActive: true } },
          },
          skip,
          take: limit,
          orderBy: [{ storeLocationId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
        }),
        prisma.register.count({ where }),
      ]);
      return success(res, { registers: rows.map(withWhatItHas), total });
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

export default requirePermission("pos.operate", handler);
