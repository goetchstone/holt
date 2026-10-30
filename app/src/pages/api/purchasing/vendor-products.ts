// /app/src/pages/api/purchasing/vendor-products.ts
//
// GAP-01: GET ?vendorId=&search= -- the products a PO line can order from one
// vendor, for the PO editor's picker: that vendor's active, current products
// matching the search by name, number or UPC. Each carries its catalog cost,
// which a new line starts from, for a holder of "View cost".
//
// Its own route rather than a vendor filter on /api/products, which seven
// screens share under their own keys: this one is "Write purchase orders".

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { logError } from "@/lib/logger";

const LIMIT = 20;

/** Exported for integration tests. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const vendorId = Number.parseInt(String(req.query.vendorId), 10);
  if (Number.isNaN(vendorId)) return res.status(400).json({ error: "Choose a vendor." });
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const showCost = canViewCost(access);

  try {
    const where: Prisma.ProductWhereInput = {
      vendorId,
      isActive: true,
      isDiscontinued: false,
      ...((buildSearchFilter(search, ["name", "productNumber", "upcs.some.upc"]) ??
        {}) as Prisma.ProductWhereInput),
    };
    const products = await prisma.product.findMany({
      where,
      orderBy: { name: "asc" },
      take: LIMIT,
      select: { id: true, productNumber: true, name: true, baseCost: true },
    });
    return res.status(200).json({
      costVisible: showCost,
      products: products.map(({ baseCost, ...p }) => ({
        ...p,
        ...(showCost ? { baseCost: baseCost === null ? null : Number(baseCost) } : {}),
      })),
    });
  } catch (err) {
    logError("Error searching vendor products", err);
    return res.status(500).json({ error: "Failed to search products." });
  }
}

export default requirePermission("purchasing.write", handler, WITH_COST);
