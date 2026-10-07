// /app/src/pages/api/warehouse/locations/index.ts
//
// Store and stock-location SETUP: Admin > Setup > Stores (admin.config) and
// Warehouse > Locations (whose roles all hold inventory.transfer) read and
// write the full records here. Either screen's key admits the read, as does
// "Set up stores and stock locations" (inventory.locations.manage), the key
// every write needs; store writes also accept admin.config. Screens
// that only need the store list read /api/store-locations; pickers that choose
// a stock location read /api/store-locations/stock-locations (SEC-15).
// Per-method gates follow inventory/freeze/index.ts.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission(
      { anyOf: ["inventory.locations.manage", "admin.config", "inventory.transfer"] },
      handleGet,
    )(req, res);
  }
  if (req.method === "POST") {
    return requirePermission({ anyOf: ["inventory.locations.manage", "admin.config"] }, handlePost)(
      req,
      res,
    );
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { type, isActive } = req.query;

    const where: Record<string, unknown> = {};
    if (type && typeof type === "string") {
      where.type = type;
    }
    if (isActive === "true") {
      where.isActive = true;
    } else if (isActive === "false") {
      where.isActive = false;
    }

    const locations = await prisma.storeLocation.findMany({
      where,
      orderBy: { sortOrder: "asc" },
      // What the two setup screens show and send back. Not the tax
      // district, traffic mapping or audit columns, which neither reads.
      select: {
        id: true,
        name: true,
        code: true,
        type: true,
        address: true,
        city: true,
        state: true,
        zip: true,
        isActive: true,
        sortOrder: true,
        externalLocationName: true,
        defaultReceivingStockLocationId: true,
        stockLocations: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            building: true,
            floor: true,
            area: true,
            locationType: true,
            squareFootage: true,
            isActive: true,
            sortOrder: true,
            // Both of these feed the edit modal, which PUTs the whole form
            // back. Omitting a field here doesn't just hide it -- the modal
            // sends its empty/false default and the PUT overwrites the
            // stored value. `locationAliases` was already being wiped on
            // every edit that way; `holdsCommittedStock` would have
            // silently reclassified a location's stock as sellable on the
            // next save.
            locationAliases: true,
            holdsCommittedStock: true,
          },
        },
      },
    });
    return res.status(200).json({ locations });
  } catch (error) {
    logError("Error fetching locations", error);
    return res.status(500).json({ error: "Failed to fetch locations" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    const {
      name,
      code,
      type,
      address,
      city,
      state,
      zip,
      externalLocationName,
      isActive,
      sortOrder,
    } = req.body;

    if (!name || !code || !type) {
      return res.status(400).json({ error: "Name, code, and type are required." });
    }

    const resolvedSortOrder =
      sortOrder !== undefined
        ? Number.parseInt(sortOrder)
        : ((await prisma.storeLocation.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ??
            0) + 1;

    const location = await prisma.storeLocation.create({
      data: {
        name,
        code: code.toUpperCase(),
        type,
        address: address || null,
        city: city || null,
        state: state || null,
        zip: zip || null,
        externalLocationName: externalLocationName || null,
        isActive: isActive !== undefined ? isActive : true,
        sortOrder: resolvedSortOrder,
        createdBy: session.user?.email || null,
      },
    });

    return res.status(201).json(location);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return res.status(409).json({ error: "A location with that name or code already exists." });
    }
    logError("Error creating location", error);
    return res.status(500).json({ error: "Failed to create location" });
  }
}
