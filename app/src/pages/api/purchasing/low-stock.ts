// /app/src/pages/api/purchasing/low-stock.ts
//
// GAP-14: GET what is below its reorder point (lib/purchasing/lowStock.ts), for
// Purchasing > Low Stock, with ?storeLocationId= and ?vendorId= to narrow it.
// Ordering from the list goes through /api/scan/order, which files lines on each
// vendor's open draft for the store.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { lowStockRows } from "@/lib/purchasing/lowStock";

function idParam(raw: unknown): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const rows = await lowStockRows(prisma, {
      storeLocationId: idParam(req.query.storeLocationId),
      vendorId: idParam(req.query.vendorId),
    });
    return res.status(200).json({ rows });
  } catch (err) {
    logError("GET /api/purchasing/low-stock error", err);
    return res.status(500).json({ error: "Failed to load low stock" });
  }
}

export default requirePermission("purchasing.read", handler);
