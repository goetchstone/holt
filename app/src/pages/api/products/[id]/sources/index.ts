// /app/src/pages/api/products/[id]/sources/index.ts
//
// GAP-22: the other vendors an item can be bought from
// (lib/purchasing/productSources.ts). GET is the product screen's list, for
// anyone who reads the catalog; POST adds one, for anyone who edits it, the
// key the item's barcodes take. Cost follows View cost: strip, never deny.
// Per-method gates follow referral-sources/index.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { logError } from "@/lib/logger";
import {
  ProductSourceError,
  addProductSource,
  listProductSources,
} from "@/lib/purchasing/productSources";
import type { ProductSourcesResponse } from "@/lib/purchasing/productSourcesShared";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission("catalog.read", handleGet, WITH_COST)(req, res);
  }
  if (req.method === "POST") {
    return requirePermission("catalog.write", handlePost, WITH_COST)(req, res);
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function productId(req: NextApiRequest): number {
  return Number.parseInt(String(req.query.id), 10);
}

export async function handleGet(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  const id = productId(req);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid product ID" });
  const costVisible = canViewCost(access);
  try {
    const body: ProductSourcesResponse = {
      costVisible,
      sources: await listProductSources(prisma, id, costVisible),
    };
    return res.status(200).json(body);
  } catch (err) {
    if (err instanceof ProductSourceError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("GET /api/products/[id]/sources error", err, { productId: id });
    return res.status(500).json({ error: "Failed to load the item's vendors" });
  }
}

export async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const id = productId(req);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid product ID" });
  try {
    const source = await addProductSource(prisma, id, req.body ?? {}, {
      canSetCost: canViewCost(access),
      by: session.user?.email ?? null,
    });
    return res.status(201).json(source);
  } catch (err) {
    if (err instanceof ProductSourceError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("POST /api/products/[id]/sources error", err, { productId: id });
    return res.status(500).json({ error: "Failed to add the vendor" });
  }
}
