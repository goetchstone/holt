// /app/src/pages/api/admin/relink-line-items.ts
//
// Admin-triggered backfill for OrderLineItem.productId → Product.productNumber.
// Product imports and the Marjan manifest already call backfillLineItemProductLinks
// automatically; this endpoint is for ad-hoc cleanup or one-off sweeps across
// the whole table. MANAGER/ADMIN only.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { backfillLineItemProductLinks } from "@/lib/orderLineItemLinker";
import { success, unauthorized, forbidden, methodNotAllowed, handleError } from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return unauthorized(res);

  const role = (session as { role?: string }).role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return forbidden(res, "Manager or Admin role required");
  }

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
