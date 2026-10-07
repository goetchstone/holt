// /app/src/pages/api/admin/product-pairings/index.ts
//
// GET  /api/admin/product-pairings -- list with resolved names
// POST /api/admin/product-pairings -- create
//
// ADMIN / MARKETING only. Pairings power the Missing Pieces tile on the
// Opportunities hub; MANAGERs consume the tile but don't edit rules.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { validateProductPairingInput } from "@/lib/productPairingValidation";

export default requireAuthWithRole(
  ["ADMIN", "MARKETING"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") {
      try {
        const pairings = await prisma.productPairing.findMany({
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          include: {
            fromDepartment: { select: { id: true, name: true } },
            fromCategory: { select: { id: true, name: true } },
            toDepartment: { select: { id: true, name: true } },
            toCategory: { select: { id: true, name: true } },
          },
        });
        return res.status(200).json({ pairings });
      } catch (err: unknown) {
        logError("List product pairings failed", err);
        return res.status(500).json({ error: "Failed to list pairings" });
      }
    }

    if (req.method === "POST") {
      const result = validateProductPairingInput(req.body || {});
      if (!result.ok || !result.data) {
        return res.status(400).json({ error: result.error ?? "Invalid input" });
      }

      try {
        const created = await prisma.productPairing.create({
          data: {
            ...result.data,
            createdBy: session.user?.email ?? null,
          },
        });
        return res.status(201).json(created);
      } catch (err: unknown) {
        logError("Create product pairing failed", err);
        return res.status(500).json({ error: "Failed to create pairing" });
      }
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  },
);
