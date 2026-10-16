// /app/src/pages/api/store-locations/stock-locations.ts
//
// The stock-location picker: each store with the stock locations inside it,
// for the screens that choose one: Receive PO (purchasing.write), New
// Transfer and Inventory Positions (whose roles all hold inventory.transfer),
// and the returned-stock queue's "put back" (sales.return).
// Either key admits, so granting a role one of those screens in Roles grants
// the picker behind it (SEC-15, 2026-09-30).
//
// Only what a picker shows -- each place with the place it is inside, so a
// picker can show the path -- and no aliases, no "holds committed stock" flag
// or addresses. Those belong to store and stock-location
// setup, which reads /api/warehouse/locations.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where = req.query.isActive === "true" ? { isActive: true } : {};
  try {
    const locations = await prisma.storeLocation.findMany({
      where,
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        isActive: true,
        defaultReceivingStockLocationId: true,
        stockLocations: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            code: true,
            name: true,
            locationType: true,
            isActive: true,
            parentId: true,
          },
        },
      },
    });
    return res.status(200).json({ locations });
  } catch (error) {
    logError("GET /store-locations/stock-locations error", error);
    return res.status(500).json({ error: "Failed to fetch stock locations" });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission(
      { anyOf: ["inventory.transfer", "purchasing.write", "sales.return"] },
      handleGet,
    )(req, res);
  }
  res.setHeader("Allow", "GET");
  return res.status(405).json({ error: "Method not allowed" });
}
