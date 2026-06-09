// /app/src/pages/api/admin/uncategorized-products.ts
//
// Server-side paginated list of products for the bulk categorization tool.
// Default filter: only products whose department name is "Uncategorized" —
// those are the rows that get swept up from CSV imports with missing
// dept/cat fields. Optional filters: vendor, free-text search, toggle to
// see ALL products.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { success, unauthorized, forbidden, methodNotAllowed, handleError } from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return unauthorized(res);

  const role = (session as { role?: string }).role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return forbidden(res, "Manager or Admin role required");
  }

  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const page = Math.max(1, Number.parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt((req.query.limit as string) || "50", 10)),
    );
    const search = typeof req.query.search === "string" ? req.query.search : null;
    const vendorIdRaw = typeof req.query.vendorId === "string" ? req.query.vendorId : null;
    const onlyUncategorized = req.query.onlyUncategorized !== "false"; // default true

    const searchFilter = buildSearchFilter(search, ["name", "productNumber", "description"]);
    const where: Prisma.ProductWhereInput = (searchFilter ?? {}) as Prisma.ProductWhereInput;

    if (vendorIdRaw) {
      const vendorId = Number.parseInt(vendorIdRaw, 10);
      if (!Number.isNaN(vendorId)) where.vendorId = vendorId;
    }

    if (onlyUncategorized) {
      where.department = { name: "Uncategorized" };
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ vendor: { name: "asc" } }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          productNumber: true,
          vendor: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          type: { select: { id: true, name: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    return success(res, {
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        productNumber: p.productNumber,
        vendorId: p.vendor?.id ?? null,
        vendorName: p.vendor?.name ?? null,
        departmentId: p.department?.id ?? null,
        departmentName: p.department?.name ?? null,
        categoryId: p.category?.id ?? null,
        categoryName: p.category?.name ?? null,
        typeId: p.type?.id ?? null,
        typeName: p.type?.name ?? null,
      })),
      total,
      page,
      limit,
    });
  } catch (err) {
    return handleError(res, err, "GET /admin/uncategorized-products");
  }
}
