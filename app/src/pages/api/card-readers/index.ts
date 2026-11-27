// /app/src/pages/api/card-readers/index.ts
//
// The store's card readers (Admin > Setup > Card readers): the list with what
// the processor says about each, and registering a new one. Setting up
// hardware that takes money is admin.config, as the registers screen is.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { created, handleError, methodNotAllowed, success } from "@/lib/apiResponse";
import { addCardReader, listCardReaders } from "@/lib/payments/cardReaders";
import { prisma } from "@/lib/prisma";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") {
    try {
      // The registers a reader can be put at come with the list, under this
      // screen's own key: /api/registers is the register's (pos.operate).
      const [readers, registers] = await Promise.all([
        listCardReaders(),
        prisma.register.findMany({
          where: { isActive: true },
          orderBy: [{ storeLocation: { name: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
          select: { id: true, name: true, storeLocation: { select: { name: true } } },
        }),
      ]);
      return success(res, { readers, registers });
    } catch (err) {
      return handleError(res, err, "GET /card-readers");
    }
  }

  if (req.method === "POST") {
    try {
      const reader = await addCardReader(req.body ?? {}, session.user?.email ?? null);
      await auditLog("CARD_READER_CHANGED", auditActor(session), {
        summary: `Card reader "${reader.label}" registered`,
      });
      return created(res, reader);
    } catch (err) {
      return handleError(res, err, "POST /card-readers");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requirePermission("admin.config", handler);
