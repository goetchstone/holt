// /app/src/pages/api/returns/[id]/disposition.ts
//
// The returned-stock queue's two actions for one return's piece
// (lib/inventory/returnStock.ts):
//   { action: "PUT_BACK", storeLocationId, stockLocationId? }  back on a
//       sellable place at that store (the store's receiving place when none
//       is named)
//   { action: "WRITE_OFF", reason? }  out of the books
// Neither changes the return's status: the customer's side may be closed
// already. A second action on the same piece is a 409.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { InsufficientStockError } from "@/lib/inventory/ledger";
import { putBackReturn, ReturnDispositionError, writeOffReturn } from "@/lib/inventory/returnStock";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid return ID" });
  const { action, storeLocationId, stockLocationId, reason } = req.body ?? {};
  const actor = session.user?.email ?? null;

  try {
    await prisma.$transaction(async (tx) => {
      const ret = await tx.return.findUnique({ where: { id } });
      if (!ret) throw new ReturnDispositionError("Return not found.", 400);
      if (action === "PUT_BACK") {
        const store = storeLocationId ? Number(storeLocationId) : ret.receivedLocationId;
        if (!store)
          throw new ReturnDispositionError("Choose the store to put the piece back at.", 400);
        await putBackReturn(tx, ret, {
          storeLocationId: store,
          stockLocationId: stockLocationId ? Number(stockLocationId) : null,
          actor,
        });
      } else if (action === "WRITE_OFF") {
        await writeOffReturn(tx, ret, {
          reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
          actor,
        });
      } else {
        throw new ReturnDispositionError('action must be "PUT_BACK" or "WRITE_OFF".', 400);
      }
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof ReturnDispositionError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error instanceof InsufficientStockError) {
      return res.status(409).json({
        error:
          "The piece is no longer in the returns place; it was moved by hand. Count it, then retry.",
      });
    }
    logError("Error recording a return's disposition", error);
    return res.status(500).json({ error: "Failed to record what happened to the piece" });
  }
}

export default requirePermission({ anyOf: ["sales.return", "inventory.transfer"] }, handler);
