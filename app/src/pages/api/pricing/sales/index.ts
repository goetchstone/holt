// /app/src/pages/api/pricing/sales/index.ts
//
// Scheduled sales (GAP-06 part B, DECISIONS 60), gated "Change pricing" like the
// mass price change.
//
// GET   every sale with where it stands today (UPCOMING / ON / ENDED) on the
//       store's day, and its product count.
// POST  { name, startsOn, endsOn, note?, items?: [{ productId, salePrice }] } --
//       schedule a sale and its products in one transaction (lib/pricing/sales.ts
//       createSale): each product has a regular price above its sale price and is
//       in no other sale on an overlapping day. Recorded as SALE_SCHEDULED there.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor } from "@/lib/audit";
import { logError } from "@/lib/logger";
import { saleToday } from "@/lib/pricing/salePrice";
import { SaleRefused, createSale, listSales } from "@/lib/pricing/sales";
import { parseSaleFields, parseSaleItems } from "@/lib/pricing/salesShared";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const today = await saleToday();
    if (req.method === "GET") {
      return res.status(200).json({ today, sales: await listSales(today) });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = parseSaleFields(body, today);
    if (!fields.ok) return res.status(400).json({ error: fields.error });
    const items = parseSaleItems(body.items);
    if (!items.ok) return res.status(400).json({ error: items.error });
    const sale = await createSale(fields.value, items.value, auditActor(session));
    return res.status(201).json(sale);
  } catch (err) {
    if (err instanceof SaleRefused) return res.status(err.status).json({ error: err.message });
    logError("Sales request failed", err);
    return res.status(500).json({ error: "The sale couldn't be saved; nothing was changed." });
  }
}

export default requirePermission("catalog.pricing", handler);
