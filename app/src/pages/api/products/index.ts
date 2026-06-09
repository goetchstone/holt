// /app/src/pages/api/products/index.ts

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
        include: {
          vendor: true,
          category: true,
          department: true,
          type: true,
        },
      }),
      prisma.product.count({ where }),
    ]);

    // Convert Decimal fields to safe JSON, and map related names for display
    const safeProducts = products.map((p) => ({
      ...p,
      baseRetail: p.baseRetail ? Number(p.baseRetail) : undefined,
      baseCost: p.baseCost ? Number(p.baseCost) : undefined, // Ensure cost is also converted
      created: p.created?.toISOString(),
      vendorName: p.vendor?.name, // Add vendor name for table display
      departmentName: p.department?.name,
      categoryName: p.category?.name,
      typeName: p.type?.name,
    }));

    res.status(200).json({ products: safeProducts, total });
  } catch (error) {
    logError("Error fetching products", error);
    res.status(500).json({ error: "Error fetching products" });
  }
}
