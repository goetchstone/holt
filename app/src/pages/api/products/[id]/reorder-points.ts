// /app/src/pages/api/products/[id]/reorder-points.ts
//
// GAP-14: how many of a product to keep at each store (lib/purchasing/reorderPoints.ts).
// GET is for whoever can see the product. PUT { storeLocationId, minQuantity,
// orderQuantity } and DELETE ?storeLocationId= are for whoever buys: a level
// decides what gets ordered.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import {
  ReorderPointError,
  removeReorderPoint,
  reorderPointsFor,
  setReorderPoint,
} from "@/lib/purchasing/reorderPoints";

function productIdOf(req: NextApiRequest): number | null {
  const id = Number.parseInt(req.query.id as string, 10);
  return Number.isNaN(id) ? null : id;
}

export async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const productId = productIdOf(req);
  if (productId == null) return res.status(400).json({ error: "Invalid product ID" });
  try {
    return res.status(200).json(await reorderPointsFor(prisma, productId));
  } catch (err) {
    logError("GET /api/products/[id]/reorder-points error", err);
    return res.status(500).json({ error: "Failed to load the reorder points" });
  }
}

export async function handleWrite(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const productId = productIdOf(req);
  if (productId == null) return res.status(400).json({ error: "Invalid product ID" });
  try {
    if (req.method === "PUT") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      await setReorderPoint(prisma, {
        productId,
        storeLocationId: body.storeLocationId,
        minQuantity: body.minQuantity,
        orderQuantity: body.orderQuantity,
        actor: session.user?.email ?? null,
      });
    } else {
      await removeReorderPoint(prisma, productId, req.query.storeLocationId);
    }
    return res.status(200).json(await reorderPointsFor(prisma, productId));
  } catch (err) {
    if (err instanceof ReorderPointError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("Saving a reorder point failed", err, { productId });
    return res.status(500).json({ error: "Failed to save the reorder point" });
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission({ anyOf: ["catalog.read", "purchasing.read"] }, handleGet)(req, res);
  }
  if (req.method === "PUT" || req.method === "DELETE") {
    return requirePermission("purchasing.write", handleWrite)(req, res);
  }
  res.setHeader("Allow", "GET, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
