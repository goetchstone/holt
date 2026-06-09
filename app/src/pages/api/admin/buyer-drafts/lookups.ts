// /app/src/pages/api/admin/buyer-drafts/lookups.ts
//
// One-shot fetch for the dropdowns the buyer-drafts page needs: vendors,
// stock locations, store locations, departments, categories, types. Saves
// the page from making 5 parallel calls and lets us cap each list with
// sensible filters (active vendors only, store-local stock locations).
//
// ADMIN-only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["ADMIN"],
  async (_req: NextApiRequest, res: NextApiResponse) => {
    try {
      const [vendors, stockLocations, storeLocations, departments, categories, types, buys] =
        await Promise.all([
          prisma.vendor.findMany({
            select: { id: true, name: true, code: true },
            orderBy: { name: "asc" },
          }),
          prisma.stockLocation.findMany({
            where: { isActive: true },
            select: { id: true, code: true, name: true, storeLocationId: true },
            orderBy: [{ storeLocationId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
          }),
          prisma.storeLocation.findMany({
            where: { isActive: true },
            select: { id: true, code: true, name: true },
            orderBy: { sortOrder: "asc" },
          }),
          prisma.department.findMany({
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          }),
          prisma.category.findMany({
            select: { id: true, name: true, departmentId: true },
            orderBy: { name: "asc" },
          }),
          prisma.type.findMany({
            select: { id: true, name: true, categoryId: true },
            orderBy: { name: "asc" },
          }),
          // Buys for the wizard's Buy selector + the workbench's Buys panel.
          // Only PLANNING / OPEN show in pickers (CLOSED / EXPORTED are
          // historical); the workbench-page Buys panel filters in JS to
          // surface the full list when the buyer opens that view.
          prisma.buyerDraftBuy.findMany({
            select: {
              id: true,
              name: true,
              season: true,
              year: true,
              budget: true,
              status: true,
            },
            orderBy: [{ year: "desc" }, { created: "desc" }],
          }),
        ]);

      return res.status(200).json({
        vendors,
        stockLocations,
        storeLocations,
        departments,
        categories,
        types,
        buys,
      });
    } catch (err) {
      logError("buyer-drafts lookups failed", err);
      return res.status(500).json({ error: "Failed to load lookups" });
    }
  },
);
