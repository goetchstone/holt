// /app/src/pages/api/sales/orders/[id]/undo-handover.ts
//
// GAP-07: POST { reason } undoes the order's latest handover, recorded by
// mistake (lib/fulfilment/undoHandover.ts): its units come back on the books
// committed to it, the order reopens, a delivery goes back in the dispatch
// pool. "Undo a handover" (sales.undo-handover) is a manager's by default
// (owner, 2026-11-03); refused once commission on the order is paid out.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { UndoHandoverError, undoHandover } from "@/lib/fulfilment/undoHandover";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const salesOrderId = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(salesOrderId)) return res.status(400).json({ error: "Invalid order ID" });
  try {
    const result = await prisma.$transaction((tx) =>
      undoHandover(tx, {
        salesOrderId,
        reason: req.body?.reason,
        actor: session.user?.email ?? null,
      }),
    );
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof UndoHandoverError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("POST /api/sales/orders/[id]/undo-handover error", err);
    return res.status(500).json({ error: "Failed to undo the handover" });
  }
}

export default requirePermission("sales.undo-handover", handler);
