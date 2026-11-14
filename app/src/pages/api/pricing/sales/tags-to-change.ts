// /app/src/pages/api/pricing/sales/tags-to-change.ts
//
// GET -- the products whose tag must change today, on the store's day (GAP-06
// part B): those in a sale starting today need a SALE tag, those whose sale ended
// yesterday or was ended early since need their regular PRODUCT tag back. Prints
// nothing: the Sales screen prints them through POST /api/print-label/batch with
// kind SALE or PRODUCT (and a store), under that route's own permission and rate
// limit. Nothing prints them on a schedule.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { saleToday } from "@/lib/pricing/salePrice";
import { tagsToChange } from "@/lib/pricing/sales";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    return res.status(200).json(await tagsToChange(await saleToday()));
  } catch (err) {
    logError("Tags to change failed", err);
    return res.status(500).json({ error: "Couldn't work out which tags change today." });
  }
}

export default requirePermission("catalog.pricing", handler);
