// /app/src/pages/api/admin/relink-line-items.ts
//
// Admin-triggered backfill for OrderLineItem.productId → Product.productNumber.
// Product imports and the Marjan manifest already call backfillLineItemProductLinks
// automatically; this endpoint is for ad-hoc cleanup or one-off sweeps across
// the whole table. MANAGER/ADMIN only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { backfillLineItemProductLinks } from "@/lib/orderLineItemLinker";
import { success, methodNotAllowed, handleError } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    // Status check — how many line items are currently unlinked?
    const unlinked = await prisma.orderLineItem.count({
      where: {
        productId: null,
        partNo: { not: null },
        NOT: { partNo: "" },
        lineItemStatus: { not: "CANCELLED" },
      },
    });
    const totalActive = await prisma.orderLineItem.count({
      where: {
        lineItemStatus: { not: "CANCELLED" },
      },
    });
    return success(res, {
      unlinked,
      totalActive,
      percentUnlinked: totalActive > 0 ? (unlinked / totalActive) * 100 : 0,
    });
  }

  if (req.method === "POST") {
    try {
      const result = await backfillLineItemProductLinks({});
      return success(res, result);
    } catch (err) {
      return handleError(res, err, "POST /admin/relink-line-items");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
