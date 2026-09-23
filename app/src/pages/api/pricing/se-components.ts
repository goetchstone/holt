// /app/src/pages/api/pricing/se-components.ts
//
// GET /api/pricing/se-components?vendorId=N
// Returns all SEComponent records for a vendor, grouped by componentType.

import { requirePermission } from "@/lib/auth/requireAuth";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const vendorId = Number.parseInt(String(req.query.vendorId), 10);
  if (Number.isNaN(vendorId)) {
    return res.status(400).json({ error: "vendorId is required" });
  }

  const components = await prisma.sEComponent.findMany({
    where: { vendorId },
    orderBy: [{ componentType: "asc" }, { sortOrder: "asc" }],
  });

  // Group by componentType for easier frontend consumption
  const grouped: Record<string, typeof components> = {};
  for (const c of components) {
    if (!grouped[c.componentType]) grouped[c.componentType] = [];
    grouped[c.componentType].push(c);
  }

  return res.json({ components: grouped });
}

export default requirePermission("catalog.pricing", handler);
