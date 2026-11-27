// /app/src/pages/api/card-readers/[id].ts
//
// Rename a card reader, move it to another register or switch it off (PUT),
// or remove it from the processor and from Holt (DELETE).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { badRequest, handleError, methodNotAllowed, success } from "@/lib/apiResponse";
import { removeCardReader, updateCardReader } from "@/lib/payments/cardReaders";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return badRequest(res, "Invalid ID");

  if (req.method === "PUT") {
    try {
      const reader = await updateCardReader(id, req.body ?? {}, session.user?.email ?? null);
      await auditLog("CARD_READER_CHANGED", auditActor(session), {
        summary: `Card reader "${reader.label}" changed`,
      });
      return success(res, reader);
    } catch (err) {
      return handleError(res, err, `PUT /card-readers/${id}`);
    }
  }

  if (req.method === "DELETE") {
    try {
      const reader = await removeCardReader(id);
      await auditLog("CARD_READER_CHANGED", auditActor(session), {
        summary: `Card reader "${reader.label}" removed`,
      });
      return success(res, { success: true });
    } catch (err) {
      return handleError(res, err, `DELETE /card-readers/${id}`);
    }
  }

  return methodNotAllowed(res, ["PUT", "DELETE"]);
}

export default requirePermission("admin.config", handler);
