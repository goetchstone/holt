// /app/src/pages/api/scan/resolve.ts
//
// What a scan is, and what is there (lib/scan/resolveScan.ts, lib/scan/
// lookup.ts). Every handheld page asks this to read a scan, so it admits
// anyone who works the floor: inventory readers and warehouse/dispatch staff.
//
// GET ?code=<scanned text>&storeLocationId=<the store the scanner is in>
//     &stock=1 to include where a product sits / what a place holds.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { resolveScan } from "@/lib/scan/resolveScan";
import { placeContents, productStock } from "@/lib/scan/lookup";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code.trim()) return res.status(400).json({ error: "code is required." });
  const storeLocationId = Number(req.query.storeLocationId) || null;
  try {
    const result = await resolveScan(prisma, code, { storeLocationId });
    let stock = null;
    if (req.query.stock === "1") {
      if (result.kind === "product") stock = await productStock(prisma, result.product.id);
      if (result.kind === "place") stock = await placeContents(prisma, result.place);
    }
    return res.status(200).json({ result, stock });
  } catch (error) {
    logError("Error resolving a scan", error);
    return res.status(500).json({ error: "Failed to look up the scan" });
  }
}

export default requirePermission({ anyOf: ["inventory.read", "warehouse.operate"] }, handler);
