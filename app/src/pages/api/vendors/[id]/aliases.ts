// /app/src/pages/api/vendors/[id]/aliases.ts
//
// GAP-22: the names a vendor went by before others were merged into it
// (VendorAlias). Every lookup of a vendor by name finds the vendor through
// them (lib/vendors/vendorByName.ts). GET lists them for anyone who reads the
// catalog. DELETE ?aliasId= forgets one, so the next import of that name makes
// a new vendor again: the way back from a wrong merge, so admin.data, like the
// merge itself.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import type { VendorAliasRow } from "@/lib/vendors/vendorMergeShared";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return requirePermission("catalog.read", handleGet)(req, res);
  if (req.method === "DELETE") return requirePermission("admin.data", handleDelete)(req, res);
  res.setHeader("Allow", "GET, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const vendorId = Number(req.query.id);
  if (!Number.isInteger(vendorId)) return res.status(400).json({ error: "Invalid vendor id" });
  try {
    const aliases: VendorAliasRow[] = await prisma.vendorAlias.findMany({
      where: { vendorId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, created: true, createdBy: true },
    });
    return res.status(200).json(aliases);
  } catch (err) {
    logError("GET /api/vendors/[id]/aliases error", err, { vendorId });
    return res.status(500).json({ error: "Failed to load the vendor's earlier names" });
  }
}

export async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const vendorId = Number(req.query.id);
  const aliasId = Number(req.query.aliasId);
  if (!Number.isInteger(vendorId) || !Number.isInteger(aliasId)) {
    return res.status(400).json({ error: "Invalid vendor or name id" });
  }
  try {
    const { count } = await prisma.vendorAlias.deleteMany({ where: { id: aliasId, vendorId } });
    if (count === 0) {
      return res.status(404).json({ error: "That name isn't one of this vendor's." });
    }
    return res.status(204).end();
  } catch (err) {
    logError("DELETE /api/vendors/[id]/aliases error", err, { vendorId, aliasId });
    return res.status(500).json({ error: "Failed to forget the name" });
  }
}
