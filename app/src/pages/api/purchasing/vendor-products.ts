// /app/src/pages/api/purchasing/vendor-products.ts
//
// GAP-01: GET ?vendorId=&search= -- the products a PO line can order from one
// vendor, for the PO editor's picker: the active, current products that vendor
// sells us (its own, and others' it is listed on, GAP-22) matching the search
// by name, number or UPC. Each carries the number and, for a holder of "View
// cost", the cost of ordering it from this vendor (buyingTerms), which a new
// line starts from.
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
import { SOURCE_TERMS, termsFrom } from "@/lib/purchasing/stockPurchaseOrder";
import type { VendorProductsResponse } from "@/lib/purchasing/purchaseOrderShared";

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
      AND: [
        { OR: [{ vendorId }, { sources: { some: { vendorId } } }] },
        { isActive: true, isDiscontinued: false },
        (buildSearchFilter(search, [
          "name",
          "productNumber",
          "upcs.some.upc",
          "sources.some.itemNumber",
        ]) ?? {}) as Prisma.ProductWhereInput,
      ],
    };
    const products = await prisma.product.findMany({
      where,
      orderBy: { name: "asc" },
      take: LIMIT,
      select: {
        id: true,
        productNumber: true,
        name: true,
        vendorId: true,
        baseCost: true,
        sources: { where: { vendorId }, select: SOURCE_TERMS },
      },
    });
    const body: VendorProductsResponse = {
      costVisible: showCost,
      products: products.flatMap((p) => {
        const terms = termsFrom(p, vendorId);
        if (!terms) return [];
        return [
          {
            id: p.id,
            name: p.name,
            productNumber: p.productNumber,
            partNo: terms.partNo,
            ...(showCost ? { cost: terms.cost } : {}),
          },
        ];
      }),
    };
    return res.status(200).json(body);
  } catch (err) {
    logError("Error searching vendor products", err);
    return res.status(500).json({ error: "Failed to search products." });
  }
}

export default requirePermission("purchasing.write", handler, WITH_COST);
