// /app/src/pages/api/store-locations/index.ts
//
// The store list: every store and warehouse's id, name, code, type and
// whether it is active. Twelve screens need exactly this and nothing more
// (Home, Admin > Staff, New Quote, Till, POS, Registers, Consignment Receive,
// Receiving Gaps, Service, New Service Case, New House Call, Till
// Reconciliation), and Home is open to every staff member, so it is on the
// baseline key: any of those screens' keys would admit the same people.
// The sibling /api/staff/active-store is on staff.self for the same reason.
//
// Stock-location detail is not here. The pickers that choose a stock
// location read /api/store-locations/stock-locations; store and stock-location
// setup reads /api/warehouse/locations (SEC-15, 2026-09-30).

import type { NextApiRequest, NextApiResponse } from "next";
import { LocationType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

const LOCATION_TYPES = new Set<string>(Object.values(LocationType));

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { type, isActive } = req.query;
  const where: Prisma.StoreLocationWhereInput = {};
  if (type !== undefined) {
    if (typeof type !== "string" || !LOCATION_TYPES.has(type)) {
      return res
        .status(400)
        .json({ error: `type must be one of ${[...LOCATION_TYPES].join(", ")}` });
    }
    where.type = type as LocationType;
  }
  if (isActive === "true") where.isActive = true;
  else if (isActive === "false") where.isActive = false;

  try {
    const locations = await prisma.storeLocation.findMany({
      where,
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, code: true, type: true, isActive: true },
    });
    return res.status(200).json({ locations });
  } catch (error) {
    logError("GET /store-locations error", error);
    return res.status(500).json({ error: "Failed to fetch store locations" });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission("staff.self", handleGet)(req, res);
  }
  res.setHeader("Allow", "GET");
  return res.status(405).json({ error: "Method not allowed" });
}
