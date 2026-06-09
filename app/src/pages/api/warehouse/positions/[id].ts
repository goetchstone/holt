// /app/src/pages/api/warehouse/positions/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { success, badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";

// Mutating inventory positions (quantity changes, moves, deletes) is a
// warehouse task. Outside of warehouse / manager / admin, no role has a
// legitimate workflow reason to edit a position directly.
export default requireAuthWithRole(
  ["WAREHOUSE", "MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const positionId = Number.parseInt(req.query.id as string);
    if (Number.isNaN(positionId)) return badRequest(res, "Invalid position ID");

    if (req.method === "PUT") {
      try {
        const { quantity, stockLocationId, storeLocationId, salesOrderId, notes } = req.body;

        const position = await prisma.inventoryPosition.update({
          where: { id: positionId },
          data: {
            ...(quantity !== undefined && { quantity }),
            ...(stockLocationId !== undefined && { stockLocationId: stockLocationId ?? null }),
            ...(storeLocationId !== undefined && { storeLocationId }),
            ...(salesOrderId !== undefined && { salesOrderId: salesOrderId ?? null }),
            ...(notes !== undefined && { notes: notes ?? null }),
            updatedBy: session.user?.email || null,
          },
        });

        return success(res, position);
      } catch (err) {
        return handleError(res, err, "PUT /warehouse/positions/[id]");
      }
    }

    if (req.method === "DELETE") {
      try {
        await prisma.inventoryPosition.delete({ where: { id: positionId } });
        return success(res, { success: true });
      } catch (err) {
        return handleError(res, err, "DELETE /warehouse/positions/[id]");
      }
    }

    return methodNotAllowed(res, ["PUT", "DELETE"]);
  },
);
