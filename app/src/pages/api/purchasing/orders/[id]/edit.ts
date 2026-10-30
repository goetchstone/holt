// /app/src/pages/api/purchasing/orders/[id]/edit.ts
//
// GAP-01: PUT { shipToLocationId, expectedDelivery, notes, lines } -- change a
// PO from its editor, until anything is received against it
// (lib/purchasing/stockPurchaseOrder.ts). The lines sent are the PO's lines:
// one left out is removed. "Write purchase orders"; a writer without "View
// cost" keeps each line's cost and gets the catalog's for a new one.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { logError } from "@/lib/logger";
import { parsePoDraft } from "@/lib/purchasing/purchaseOrderShared";
import { PurchaseOrderError, editPurchaseOrder } from "@/lib/purchasing/stockPurchaseOrder";

/** Exported for integration tests. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const poId = Number.parseInt(String(req.query.id), 10);
  if (Number.isNaN(poId)) return res.status(400).json({ error: "Invalid purchase order ID." });
  const input = parsePoDraft(req.body);
  if (!input.ok) return res.status(400).json({ error: input.problem });

  try {
    await editPurchaseOrder(poId, input.value, {
      actor: session.user?.email ?? null,
      canSetCost: canViewCost(access),
    });
    return res.status(200).json({ id: poId });
  } catch (err) {
    if (err instanceof PurchaseOrderError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("Error editing purchase order", err);
    return res.status(500).json({ error: "Failed to save the purchase order." });
  }
}

export default requirePermission("purchasing.write", handler, WITH_COST);
