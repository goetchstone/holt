// /app/src/pages/api/purchasing/orders/[id]/duplicate.ts
//
// GAP-01: POST -> { id, poNumber, skipped } -- a new draft with this PO's
// vendor, ship-to, notes and lines (lib/purchasing/stockPurchaseOrder.ts).
// `skipped` names each line that couldn't come across. "Write purchase orders".

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { PurchaseOrderError, duplicatePurchaseOrder } from "@/lib/purchasing/stockPurchaseOrder";

/** Exported for integration tests. */
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const poId = Number.parseInt(String(req.query.id), 10);
  if (Number.isNaN(poId)) return res.status(400).json({ error: "Invalid purchase order ID." });

  try {
    const copy = await duplicatePurchaseOrder(poId, session.user?.email ?? null);
    return res.status(201).json(copy);
  } catch (err) {
    if (err instanceof PurchaseOrderError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("Error duplicating purchase order", err);
    return res.status(500).json({ error: "Failed to duplicate the purchase order." });
  }
}

export default requirePermission("purchasing.write", handler);
