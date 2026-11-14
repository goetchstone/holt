// /app/src/pages/api/pricing/sales/[id].ts
//
// One scheduled sale (GAP-06 part B), gated "Change pricing".
//
// GET     the sale, where it stands today, and its products with their regular
//         and sale prices.
// PATCH   { name?, note?, startsOn?, endsOn?, items? } -- name and note at any
//         time; dates (both together) and products only before it starts. New
//         items replace the old, checked as a new sale's are. SALE_CHANGED.
// DELETE  only a sale that hasn't started. SALE_DELETED.
//
// Ending a sale early is POST ./end. Every change is recorded by
// lib/pricing/sales.ts in its own transaction.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor } from "@/lib/audit";
import { logError } from "@/lib/logger";
import { saleToday } from "@/lib/pricing/salePrice";
import { SaleRefused, deleteSale, getSale, updateSale } from "@/lib/pricing/sales";
import { parseSalePatch } from "@/lib/pricing/salesShared";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "GET" && req.method !== "PATCH" && req.method !== "DELETE") {
    res.setHeader("Allow", "GET, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid sale id" });
  try {
    const today = await saleToday();
    if (req.method === "GET") return res.status(200).json(await getSale(id, today));
    if (req.method === "DELETE") {
      await deleteSale(id, auditActor(session), today);
      return res.status(200).json({ deleted: true });
    }
    const patch = parseSalePatch(req.body);
    if (!patch.ok) return res.status(400).json({ error: patch.error });
    await updateSale(id, patch.value, auditActor(session), today);
    return res.status(200).json(await getSale(id, today));
  } catch (err) {
    if (err instanceof SaleRefused) return res.status(err.status).json({ error: err.message });
    logError("Sale request failed", err);
    return res.status(500).json({ error: "The sale couldn't be changed; nothing was changed." });
  }
}

export default requirePermission("catalog.pricing", handler);
