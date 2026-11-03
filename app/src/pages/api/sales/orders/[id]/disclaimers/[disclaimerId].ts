// /app/src/pages/api/sales/orders/[id]/disclaimers/[disclaimerId].ts
//
// GAP-07: DELETE takes a disclaimer off an order, while it is a quote or an
// order (lib/sales/orderDisclaimers.ts). The id is the order's copy
// (SalesOrderDisclaimer), not the store's disclaimer.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { returnOrderEditProblem } from "@/lib/returns/bookReturn";
import { DisclaimerError, removeOrderDisclaimer } from "@/lib/sales/orderDisclaimers";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const salesOrderId = Number.parseInt(req.query.id as string, 10);
  const id = Number.parseInt(req.query.disclaimerId as string, 10);
  if (Number.isNaN(salesOrderId) || Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid order or disclaimer ID" });
  }
  try {
    const locked = await returnOrderEditProblem(prisma, salesOrderId);
    if (locked) return res.status(409).json({ error: locked });
    const disclaimers = await prisma.$transaction((tx) =>
      removeOrderDisclaimer(tx, { salesOrderId, id, actor: session.user?.email ?? null }),
    );
    return res.status(200).json({ disclaimers });
  } catch (err) {
    if (err instanceof DisclaimerError) return res.status(err.status).json({ error: err.message });
    logError("DELETE /api/sales/orders/[id]/disclaimers/[disclaimerId] error", err);
    return res.status(500).json({ error: "Failed to take the disclaimer off" });
  }
}

export default requirePermission("sales.write", handler);
