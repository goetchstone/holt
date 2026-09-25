// /app/src/pages/api/products/index.ts
//
// Product search, shared by seven screens. Each screen's own key admits the
// caller, so granting a role any of those screens in Roles also grants the
// search behind it:
//   catalog.read        All Products (/app/inventory/products)
//   catalog.write       Create Variant's master-product picker
//   sales.write         New Quote, and Detailed Sales' "Edit line item" relink
//   pos.operate         POS
//   inventory.count     Reconcile Photos
//   inventory.transfer  New Transfer (the key its save route uses)
// It selects what those screens read. The vendor row stays on the server
// (account number, discounts, markup, terms, contacts), as do staff emails
// and the wholesale price-list inputs. baseCost still goes to every admitted
// role, as before; whether cost gets its own switch is SEC-14.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { logError } from "@/lib/logger";

const NAME_ONLY = { select: { name: true } } as const;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).end();
  }

  try {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10; // Default to 10 for consistency
    const search = (req.query.search as string)?.trim() || "";

    const skip = (page - 1) * limit;

    // Multi-token search via the shared buildSearchFilter utility.
    const searchFilter = buildSearchFilter(search, [
      "name",
      "productNumber",
      "description",
      "upcs.some.upc",
    ]);
    const where: Prisma.ProductWhereInput = (searchFilter ?? {}) as Prisma.ProductWhereInput;

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { name: "asc" },
        select: {
          id: true,
          productNumber: true,
          name: true,
          description: true,
          season: true,
          baseRetail: true,
          baseCost: true,
          length: true,
          depth: true,
          height: true,
          serviceType: true,
          vendorId: true,
          departmentId: true,
          categoryId: true,
          typeId: true,
          created: true,
          vendor: NAME_ONLY,
          category: NAME_ONLY,
          department: NAME_ONLY,
          type: NAME_ONLY,
        },
      }),
      prisma.product.count({ where }),
    ]);

    // Convert Decimal fields to safe JSON, and flatten related names for display
    const safeProducts = products.map(({ vendor, category, department, type, ...p }) => ({
      ...p,
      baseRetail: p.baseRetail ? Number(p.baseRetail) : undefined,
      baseCost: p.baseCost ? Number(p.baseCost) : undefined, // Ensure cost is also converted
      created: p.created?.toISOString(),
      vendorName: vendor?.name,
      departmentName: department?.name,
      categoryName: category?.name,
      typeName: type?.name,
    }));

    res.status(200).json({ products: safeProducts, total });
  } catch (error) {
    logError("Error fetching products", error);
    res.status(500).json({ error: "Error fetching products" });
  }
}

export default requirePermission(
  {
    anyOf: [
      "catalog.read",
      "catalog.write",
      "sales.write",
      "pos.operate",
      "inventory.count",
      "inventory.transfer",
    ],
  },
  handler,
);
