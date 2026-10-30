// /app/src/pages/api/purchasing/orders/[id]/charges/index.ts
//
// GAP-02: POST { description, amount, splitBy? } -> { id, unabsorbed } -- a
// landed charge (freight, duty, crating) on a PO, spread across its lines into
// their landed cost (lib/purchasing/landedCost.ts). Goods already received take
// their share now, on their products' average; `unabsorbed` is any share that
// found no stock on hand to land on. The split defaults to the store's
// (Settings > Landed cost).
//
// "Write purchase orders", and "View cost": a charge is nothing but cost, so a
// writer who can't see cost can't enter one.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { getAppSettings } from "@/lib/appSettings";
import { logError } from "@/lib/logger";
import { parseCharge } from "@/lib/purchasing/landedCostShared";
import { ChargeError, addCharge } from "@/lib/purchasing/landedCost";

/** Exported for integration tests. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!canViewCost(access)) {
    return res
      .status(403)
      .json({ error: "Landed charges are cost: entering one needs View cost." });
  }
  const poId = Number.parseInt(String(req.query.id), 10);
  if (Number.isNaN(poId)) return res.status(400).json({ error: "Invalid purchase order ID." });
  const input = parseCharge(req.body, (await getAppSettings()).landedCostSplit);
  if (!input.ok) return res.status(400).json({ error: input.problem });

  try {
    const added = await prisma.$transaction((tx) =>
      addCharge(tx, { poId, ...input.value, actor: session.user?.email ?? null }),
    );
    return res.status(201).json(added);
  } catch (err) {
    if (err instanceof ChargeError) return res.status(err.status).json({ error: err.message });
    logError("Error adding a landed charge", err);
    return res.status(500).json({ error: "Failed to add the charge." });
  }
}

export default requirePermission("purchasing.write", handler, WITH_COST);
