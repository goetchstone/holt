// /app/src/pages/api/order-disclaimers/[id].ts
//
// Reword, rename, reorder, switch off or delete one of the store's disclaimers
// (Settings > Disclaimers). Orders already given it keep the text they were
// given (lib/sales/orderDisclaimers.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { DisclaimerError, deleteDisclaimer, updateDisclaimer } from "@/lib/sales/orderDisclaimers";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid disclaimer ID" });
  const by = session.user?.email ?? null;
  try {
    if (req.method === "PUT") {
      const disclaimer = await prisma.$transaction((tx) =>
        updateDisclaimer(tx, id, req.body ?? {}, by),
      );
      return res.status(200).json(disclaimer);
    }
    if (req.method === "DELETE") {
      await prisma.$transaction((tx) => deleteDisclaimer(tx, id));
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    if (err instanceof DisclaimerError) return res.status(err.status).json({ error: err.message });
    logError(`${req.method} /api/order-disclaimers/[id] error`, err);
    return res.status(500).json({ error: "Failed to save the disclaimer" });
  }
  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("admin.settings", handler);
