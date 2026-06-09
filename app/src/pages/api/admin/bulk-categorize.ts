// /app/src/pages/api/admin/bulk-categorize.ts
//
// Apply a vendor / department / category / type to a batch of products in
// one request. Validates that the category belongs to the selected
// department (and type belongs to the category) before updating.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { success, badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";

interface Body {
  productIds: number[];
  vendorId?: number | null;
  departmentId?: number | null;
  categoryId?: number | null;
  typeId?: number | null;
}

const MAX_IDS = 500;

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

    const body = req.body as Body;

    if (!Array.isArray(body.productIds) || body.productIds.length === 0) {
      return badRequest(res, "productIds is required");
    }
    if (body.productIds.length > MAX_IDS) {
      return badRequest(res, `Cannot bulk-update more than ${MAX_IDS} products at once`);
    }
    if (body.productIds.some((id) => !Number.isInteger(id))) {
      return badRequest(res, "productIds must be integers");
    }

    // At least one field must be set
    const hasChange =
      body.vendorId !== undefined ||
      body.departmentId !== undefined ||
      body.categoryId !== undefined ||
      body.typeId !== undefined;
    if (!hasChange) return badRequest(res, "No fields to update");

    try {
      // Validate category ↔ department ↔ type relationships.
      if (body.categoryId && body.departmentId) {
        const cat = await prisma.category.findUnique({
          where: { id: body.categoryId },
          select: { departmentId: true },
        });
        if (!cat || cat.departmentId !== body.departmentId) {
          return badRequest(res, "Selected category does not belong to the selected department");
        }
      }

      if (body.typeId && body.categoryId) {
        const type = await prisma.type.findUnique({
          where: { id: body.typeId },
          select: { categoryId: true },
        });
        if (!type || type.categoryId !== body.categoryId) {
          return badRequest(res, "Selected type does not belong to the selected category");
        }
      }

      const data: Record<string, number | null> = {};
      if (body.vendorId !== undefined) data.vendorId = body.vendorId;
      if (body.departmentId !== undefined) data.departmentId = body.departmentId;
      if (body.categoryId !== undefined) data.categoryId = body.categoryId;
      if (body.typeId !== undefined) data.typeId = body.typeId;

      const result = await prisma.product.updateMany({
        where: { id: { in: body.productIds } },
        data,
      });

      return success(res, { updated: result.count });
    } catch (err) {
      return handleError(res, err, "POST /admin/bulk-categorize");
    }
  },
);
