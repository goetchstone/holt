// /app/src/pages/api/pricing/mass-change/index.ts
//
// GET -- the products a mass price change can pick from (GAP-06), filtered by
// vendor, department, category, text and lock, a page at a time. Its own list
// so the six screens on /api/products keep their contract. Gated like the rest
// of the mass change: "Change pricing". Cost goes only to a holder of "View
// cost" (SEC-14, lib/auth/costVisibility.ts); the response says which.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { WITH_COST, canViewCost } from "@/lib/auth/costVisibility";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { massChangeWhere } from "@/lib/pricing/massChange";
import { moneyOrNull } from "@/lib/pricing/retailWriter";
import { MASS_CHANGE_PAGE_SIZE_MAX, parseMassChangeFilter } from "@/lib/pricing/massChangeShared";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const q = req.query;
  const filter = parseMassChangeFilter({
    vendorId: first(q.vendorId),
    departmentId: first(q.departmentId),
    categoryId: first(q.categoryId),
    q: first(q.q),
    locked: first(q.locked),
  });
  if (!filter.ok) return res.status(400).json({ error: filter.error });
  const page = Math.max(1, Number.parseInt(first(q.page) ?? "1", 10) || 1);
  const pageSize = Math.min(
    MASS_CHANGE_PAGE_SIZE_MAX,
    Math.max(1, Number.parseInt(first(q.pageSize) ?? "50", 10) || 50),
  );

  const costVisible = canViewCost(access);

  try {
    const where = massChangeWhere(filter.value);
    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: { id: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          productNumber: true,
          name: true,
          baseCost: true,
          baseRetail: true,
          wasPrice: true,
          priceLocked: true,
          vendor: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
        },
      }),
    ]);
    return res.status(200).json({
      total,
      page,
      pageSize,
      costVisible,
      rows: products.map((p) => ({
        id: p.id,
        productNumber: p.productNumber,
        name: p.name,
        vendor: p.vendor,
        department: p.department,
        category: p.category,
        ...(costVisible && { baseCost: moneyOrNull(p.baseCost) }),
        baseRetail: moneyOrNull(p.baseRetail),
        wasPrice: moneyOrNull(p.wasPrice),
        priceLocked: p.priceLocked,
      })),
    });
  } catch (err) {
    logError("Mass price change list failed", err);
    return res.status(500).json({ error: "Couldn't load the products." });
  }
}

export default requirePermission("catalog.pricing", handler, WITH_COST);
