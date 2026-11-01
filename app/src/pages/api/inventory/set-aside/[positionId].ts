// /app/src/pages/api/inventory/set-aside/[positionId].ts
//
// GAP-16: what happens to stock set aside in quarantine
// (lib/inventory/setAside.ts). POST with
//   { action: "put-back", quantity, stockLocationId }  back on sale at a
//                                                       sellable place, same store
//   { action: "write-off", quantity, note }             out of the books, with why
// Both change what is for sale, so they need "Adjust inventory".

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import { SetAsideError, putBackSetAside, writeOffSetAside } from "@/lib/inventory/setAside";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session | null) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const positionId = Number(req.query.positionId);
  if (!Number.isInteger(positionId)) return badRequest(res, "Invalid position id.");
  const { action, quantity, stockLocationId, note } = (req.body ?? {}) as Record<string, unknown>;
  const actor = session?.user?.email ?? null;
  try {
    if (action === "put-back") {
      await prisma.$transaction((tx) =>
        putBackSetAside(tx, { positionId, quantity, stockLocationId, actor }),
      );
    } else if (action === "write-off") {
      await prisma.$transaction((tx) =>
        writeOffSetAside(tx, { positionId, quantity, note, actor }),
      );
    } else {
      return badRequest(res, 'action must be "put-back" or "write-off".');
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof SetAsideError) return res.status(err.status).json({ error: err.message });
    return handleError(res, err, "POST /inventory/set-aside/[positionId]");
  }
}

export default requirePermission("inventory.adjust", handler);
