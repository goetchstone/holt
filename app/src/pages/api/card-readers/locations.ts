// /app/src/pages/api/card-readers/locations.ts
//
// The places readers are registered to at the card processor (one per store
// address). Listed for the "add a reader" form, and created from it when the
// store has none yet.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { created, handleError, methodNotAllowed, success } from "@/lib/apiResponse";
import { createReaderLocation, listReaderLocations } from "@/lib/payments/cardReaders";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") {
    try {
      return success(res, { locations: await listReaderLocations() });
    } catch (err) {
      return handleError(res, err, "GET /card-readers/locations");
    }
  }

  if (req.method === "POST") {
    try {
      const location = await createReaderLocation(req.body ?? {});
      await auditLog("CARD_READER_CHANGED", auditActor(session), {
        summary: `Card reader location "${location.name}" created at the processor`,
      });
      return created(res, location);
    } catch (err) {
      return handleError(res, err, "POST /card-readers/locations");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requirePermission("admin.config", handler);
