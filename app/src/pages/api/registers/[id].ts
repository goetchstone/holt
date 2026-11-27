// /app/src/pages/api/registers/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { getErrorCode } from "@/lib/errorCode";
import { isSimulatedReader } from "@/lib/payments/cardReaders";
import { isPracticeCopy } from "@/lib/practiceCopy";
import {
  success,
  badRequest,
  notFound,
  conflict,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return badRequest(res, "Invalid ID");

  if (req.method === "GET") {
    try {
      const register = await prisma.register.findUnique({
        where: { id },
        include: {
          storeLocation: { select: { name: true, code: true } },
          // The POS tags each payment with this register's open till. It reads
          // it here, under pos.operate, rather than from the till list
          // (/api/tills), which serves the Till screen and reconciliation.
          tills: {
            where: { status: "OPEN" },
            orderBy: { openedAt: "desc" },
            take: 1,
            select: { id: true },
          },
          // So the register knows to send a card payment to its reader.
          cardReader: { select: { label: true, deviceType: true, isActive: true } },
        },
      });
      if (!register) return notFound(res, "Register");
      const { tills, cardReader, ...rest } = register;
      return success(res, {
        ...rest,
        openTillId: tills[0]?.id ?? null,
        // A practice copy reaches no card processor, so its registers record a
        // card by hand, as a register with no reader does.
        cardReader:
          cardReader?.isActive && !isPracticeCopy()
            ? { label: cardReader.label, simulated: isSimulatedReader(cardReader) }
            : null,
      });
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

export default requirePermission("pos.operate", handler);
