// /app/src/pages/api/purchasing/orders/[id]/charges/[chargeId].ts
//
// GAP-02: DELETE -> { unabsorbed } -- take a landed charge off a PO; goods
// already received give their share back off their products' average
// (lib/purchasing/landedCost.ts). "Write purchase orders" and "View cost", like
// adding one.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { logError } from "@/lib/logger";
import { ChargeError, removeCharge } from "@/lib/purchasing/landedCost";

/** Exported for integration tests. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", ["DELETE"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!canViewCost(access)) {
    return res
      .status(403)
      .json({ error: "Landed charges are cost: removing one needs View cost." });
  }
  const poId = Number.parseInt(String(req.query.id), 10);
  const chargeId = Number.parseInt(String(req.query.chargeId), 10);
  if (Number.isNaN(poId) || Number.isNaN(chargeId)) {
    return res.status(400).json({ error: "Invalid purchase order or charge ID." });
  }

  try {
    const removed = await prisma.$transaction((tx) => removeCharge(tx, { poId, chargeId }));
    return res.status(200).json(removed);
  } catch (err) {
    if (err instanceof ChargeError) return res.status(err.status).json({ error: err.message });
    logError("Error removing a landed charge", err);
    return res.status(500).json({ error: "Failed to remove the charge." });
  }
}

export default requirePermission("purchasing.write", handler, WITH_COST);
