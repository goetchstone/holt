// /app/src/pages/api/products/quick-create.ts
//
// Minimal product creation from the Detailed Sales drilldown. Given a name,
// part number, vendor, department, and category (plus optional UPC / type /
// pricing), creates a Product and optionally a UPC record that points to it.
// Returns the new product id so the caller can immediately relink the
// offending line item.
//
// Purpose: when the user drills into an Uncategorized sale and the item
// isn't in the catalog at all, they can add it right there without leaving
// the report.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import {
  success,
  unauthorized,
  forbidden,
  badRequest,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

interface QuickCreateBody {
  name: string;
  productNumber: string;
  vendorId: number;
  departmentId: number;
  categoryId: number;
  typeId?: number | null;
  upc?: string | null;
  baseCost?: number | null;
  baseRetail?: number | null;
  description?: string | null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return unauthorized(res);

  const role = (session as { role?: string }).role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return forbidden(res, "Manager or Admin role required");
  }

  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const body = req.body as QuickCreateBody;

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return badRequest(res, "name is required");
  }
  if (!body.productNumber || typeof body.productNumber !== "string" || !body.productNumber.trim()) {
    return badRequest(res, "productNumber is required");
  }
  if (!Number.isInteger(body.vendorId)) return badRequest(res, "vendorId is required");
  if (!Number.isInteger(body.departmentId)) return badRequest(res, "departmentId is required");
  if (!Number.isInteger(body.categoryId)) return badRequest(res, "categoryId is required");

  try {
    // Check category belongs to the department (cheap sanity check).
    const category = await prisma.category.findUnique({
      where: { id: body.categoryId },
      select: { id: true, departmentId: true },
    });
    if (!category) return badRequest(res, "Category not found");
    if (category.departmentId !== body.departmentId) {
      return badRequest(res, "Category does not belong to the selected department");
    }

    // If type given, check it belongs to the category.
    if (body.typeId) {
      const type = await prisma.type.findUnique({
        where: { id: body.typeId },
        select: { id: true, categoryId: true },
      });
      if (!type) return badRequest(res, "Type not found");
      if (type.categoryId !== body.categoryId) {
        return badRequest(res, "Type does not belong to the selected category");
      }
    }

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: body.name.trim(),
          productNumber: body.productNumber.trim(),
          vendorId: body.vendorId,
          departmentId: body.departmentId,
          categoryId: body.categoryId,
          typeId: body.typeId ?? undefined,
          baseCost: body.baseCost ?? 0,
          baseRetail: body.baseRetail ?? 0,
          description: body.description ?? undefined,
          createdBy: session.user!.email,
        },
      });

      // Optional UPC linkage. If the UPC already exists, repoint it to this
      // new product (matches the behaviour of the backfill relinker).
      if (body.upc && body.upc.trim()) {
        const upc = body.upc.trim();
        await tx.upc.upsert({
          where: { upc },
          update: { productId: created.id },
          create: {
            upc,
            product: { connect: { id: created.id } },
            sortOrder: 0,
            source: "MANUAL",
          },
        });
      }

      return created;
    });

    return success(res, {
      id: product.id,
      productNumber: product.productNumber,
      name: product.name,
    });
  } catch (err) {
    return handleError(res, err, "POST /products/quick-create");
  }
}
