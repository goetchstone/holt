// /app/src/pages/api/pricing/sales/[id]/end.ts
//
// POST -- end a sale that is on, now (GAP-06 part B). Its sale prices stop
// applying at once; its rows stay as the record of what was charged. A sale that
// hasn't started is changed or deleted instead. Gated "Change pricing"; recorded
// as SALE_ENDED by lib/pricing/sales.ts in its transaction.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor } from "@/lib/audit";
import { logError } from "@/lib/logger";
import { saleToday } from "@/lib/pricing/salePrice";
import { SaleRefused, endSaleEarly, getSale } from "@/lib/pricing/sales";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid sale id" });
  try {
    const today = await saleToday();
    await endSaleEarly(id, auditActor(session), today);
    return res.status(200).json(await getSale(id, today));
  } catch (err) {
    if (err instanceof SaleRefused) return res.status(err.status).json({ error: err.message });
    logError("Ending a sale failed", err);
    return res.status(500).json({ error: "The sale couldn't be ended; nothing was changed." });
  }
}

export default requirePermission("catalog.pricing", handler);
