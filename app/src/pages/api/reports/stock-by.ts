// /app/src/pages/api/reports/stock-by.ts
//
// Stock and space by any field (lib/reports/stockBy.ts). ?by= is one of
// STOCK_BY_FIELDS (default "place"); ?storeLocationId= looks inside one store,
// ?stockLocationId= inside one place and everything in it.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import {
  getStockBy,
  isStockByField,
  StockByScopeError,
  STOCK_BY_FIELDS,
} from "@/lib/reports/stockBy";
import { logError } from "@/lib/logger";

function optionalId(value: unknown): number | null | undefined {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const by = req.query.by ?? "place";
  if (!isStockByField(by)) {
    return res
      .status(400)
      .json({ error: `by must be one of: ${Object.keys(STOCK_BY_FIELDS).join(", ")}.` });
  }
  const storeLocationId = optionalId(req.query.storeLocationId);
  const stockLocationId = optionalId(req.query.stockLocationId);
  if (storeLocationId === undefined) {
    return res.status(400).json({ error: "storeLocationId must be a store id." });
  }
  if (stockLocationId === undefined) {
    return res.status(400).json({ error: "stockLocationId must be a place id." });
  }
  try {
    const result = await getStockBy(prisma, { storeLocationId, stockLocationId }, by);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof StockByScopeError) return res.status(400).json({ error: error.message });
    logError("Error building the stock and space report", error);
    return res.status(500).json({ error: "Failed to build the stock and space report" });
  }
}

export default requirePermission("reporting.read", handler);
