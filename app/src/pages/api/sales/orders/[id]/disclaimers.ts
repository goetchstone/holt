// /app/src/pages/api/sales/orders/[id]/disclaimers.ts
//
// GAP-07: POST { orderDisclaimerId } copies one of the store's disclaimers onto
// an order, to print beside the store-wide footer (lib/sales/orderDisclaimers.ts).
// Only while the order is a quote or an order; a return's own order changes only
// through its return.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { returnOrderEditProblem } from "@/lib/returns/bookReturn";
import { DisclaimerError, addOrderDisclaimer } from "@/lib/sales/orderDisclaimers";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const salesOrderId = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(salesOrderId)) return res.status(400).json({ error: "Invalid order ID" });
  try {
    const locked = await returnOrderEditProblem(prisma, salesOrderId);
    if (locked) return res.status(409).json({ error: locked });
    const disclaimers = await prisma.$transaction((tx) =>
      addOrderDisclaimer(tx, {
        salesOrderId,
        orderDisclaimerId: req.body?.orderDisclaimerId,
        actor: session.user?.email ?? null,
      }),
    );
    return res.status(201).json({ disclaimers });
  } catch (err) {
    if (err instanceof DisclaimerError) return res.status(err.status).json({ error: err.message });
    logError("POST /api/sales/orders/[id]/disclaimers error", err);
    return res.status(500).json({ error: "Failed to add the disclaimer" });
  }
}

export default requirePermission("sales.write", handler);
