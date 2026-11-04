// /app/src/pages/api/order-flags/[id].ts
//
// Rename, recolour, reorder, switch off or delete one of the store's order
// flags (Settings > Order flags). One orders carry is switched off, not
// deleted (lib/sales/orderFlags.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { OrderFlagError, deleteOrderFlag, updateOrderFlag } from "@/lib/sales/orderFlags";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid flag ID" });
  const by = session.user?.email ?? null;
  try {
    if (req.method === "PUT") {
      const flag = await prisma.$transaction((tx) => updateOrderFlag(tx, id, req.body ?? {}, by));
      return res.status(200).json(flag);
    }
    if (req.method === "DELETE") {
      await prisma.$transaction((tx) => deleteOrderFlag(tx, id));
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    if (err instanceof OrderFlagError) return res.status(err.status).json({ error: err.message });
    logError(`${req.method} /api/order-flags/[id] error`, err);
    return res.status(500).json({ error: "Failed to save the flag" });
  }
  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("admin.settings", handler);
