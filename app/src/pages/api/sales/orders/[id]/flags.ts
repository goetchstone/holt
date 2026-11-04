// /app/src/pages/api/sales/orders/[id]/flags.ts
//
// GAP-07: PUT { flagIds } sets the store's flags on an order to exactly that
// list (lib/sales/orderFlags.ts setOrderFlags). Flags change no money, so any
// order can carry them, a delivered or returned one included.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { OrderFlagError, setOrderFlags } from "@/lib/sales/orderFlags";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const salesOrderId = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(salesOrderId)) return res.status(400).json({ error: "Invalid order ID" });
  try {
    const flags = await prisma.$transaction((tx) =>
      setOrderFlags(tx, {
        salesOrderId,
        flagIds: req.body?.flagIds,
        actor: session.user?.email ?? null,
      }),
    );
    return res.status(200).json({ flags });
  } catch (err) {
    if (err instanceof OrderFlagError) return res.status(err.status).json({ error: err.message });
    logError("PUT /api/sales/orders/[id]/flags error", err);
    return res.status(500).json({ error: "Failed to save the order's flags" });
  }
}

export default requirePermission("sales.write", handler);
