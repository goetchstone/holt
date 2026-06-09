// /app/src/pages/api/admin/product-pairings/[id].ts
//
// PUT    /api/admin/product-pairings/[id] -- update
// DELETE /api/admin/product-pairings/[id] -- delete
// ADMIN / MARKETING only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { validateProductPairingInput } from "@/lib/productPairingValidation";

export default requireAuthWithRole(
  ["ADMIN", "MARKETING"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const id = Number.parseInt(req.query.id as string, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }

    if (req.method === "PUT") {
      const result = validateProductPairingInput(req.body || {});
      if (!result.ok || !result.data) {
        return res.status(400).json({ error: result.error ?? "Invalid input" });
      }

      try {
        const updated = await prisma.productPairing.update({
          where: { id },
          data: {
            ...result.data,
            updatedBy: session.user?.email ?? null,
          },
        });
        return res.status(200).json(updated);
      } catch (err: unknown) {
        logError("Update product pairing failed", err);
        return res.status(500).json({ error: "Failed to update pairing" });
      }
    }

    if (req.method === "DELETE") {
      try {
        await prisma.productPairing.delete({ where: { id } });
        return res.status(204).end();
      } catch (err: unknown) {
        logError("Delete product pairing failed", err);
        return res.status(500).json({ error: "Failed to delete pairing" });
      }
    }

    res.setHeader("Allow", "PUT, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  },
);
