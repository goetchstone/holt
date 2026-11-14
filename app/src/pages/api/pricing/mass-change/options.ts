// /app/src/pages/api/pricing/mass-change/options.ts
//
// GET -- the vendors, departments and categories a mass price change can filter
// by (GAP-06): ids and names only. Its own route, gated like the rest of the
// mass change ("Change pricing"), because the taxonomy lists the catalog screens
// read are gated on "Edit catalog" -- a store's pricing-only role would get a
// screen whose filters never loaded.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const [vendors, departments, categories] = await Promise.all([
      prisma.vendor.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.category.findMany({
        select: { id: true, name: true, departmentId: true },
        orderBy: { name: "asc" },
      }),
    ]);
    return res.status(200).json({ vendors, departments, categories });
  } catch (err) {
    logError("Mass price change options failed", err);
    return res
      .status(500)
      .json({ error: "Couldn't load the vendors, departments and categories." });
  }
}

export default requirePermission("catalog.pricing", handler);
