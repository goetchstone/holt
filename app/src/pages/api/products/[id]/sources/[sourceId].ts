// /app/src/pages/api/products/[id]/sources/[sourceId].ts
//
// GAP-22: change another vendor's item number or cost for an item, or stop
// buying it from that vendor (lib/purchasing/productSources.ts). Anyone who
// edits the catalog; only a holder of View cost changes the cost.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { logError } from "@/lib/logger";
import {
  ProductSourceError,
  removeProductSource,
  updateProductSource,
} from "@/lib/purchasing/productSources";

export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const productId = Number.parseInt(String(req.query.id), 10);
  const sourceId = Number.parseInt(String(req.query.sourceId), 10);
  if (Number.isNaN(productId) || Number.isNaN(sourceId)) {
    return res.status(400).json({ error: "Invalid product or vendor ID" });
  }
  try {
    if (req.method === "PATCH") {
      const before = await prisma.productSource.findUnique({
        where: { id: sourceId },
        select: { cost: true },
      });
      const source = await updateProductSource(prisma, productId, sourceId, req.body ?? {}, {
        canSetCost: canViewCost(access),
        by: session.user?.email ?? null,
      });
      const fromCost = before?.cost == null ? null : Number(before.cost);
      const toCost = source.cost == null ? null : Number(source.cost);
      if (fromCost !== toCost) {
        await auditLog("PRODUCT_COST_CHANGED", auditActor(session), {
          summary: `Vendor cost ${fromCost ?? "none"} → ${toCost ?? "none"}`,
          target: { type: "product", id: productId },
        });
      }
      return res.status(200).json(source);
    }
    if (req.method === "DELETE") {
      await removeProductSource(prisma, productId, sourceId);
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    if (err instanceof ProductSourceError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError(`${req.method} /api/products/[id]/sources/[sourceId] error`, err, {
      productId,
      sourceId,
    });
    return res.status(500).json({ error: "Failed to save the item's vendor" });
  }
  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("catalog.write", handler, WITH_COST);
