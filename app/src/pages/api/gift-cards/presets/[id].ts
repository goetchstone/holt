// /app/src/pages/api/gift-cards/presets/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid preset ID" });

  if (req.method === "PUT") {
    const { code, amount, label, isActive, sortOrder } = req.body;

    try {
      const preset = await prisma.giftCardPreset.update({
        where: { id },
        data: {
          ...(code !== undefined && { code: code.toUpperCase().trim() }),
          ...(amount !== undefined && { amount: amount !== null ? amount : null }),
          ...(label !== undefined && { label }),
          ...(isActive !== undefined && { isActive }),
          ...(sortOrder !== undefined && { sortOrder }),
          updatedBy: session.user?.email || null,
        },
      });
      return res.status(200).json({
        ...preset,
        amount: preset.amount !== null ? Number(preset.amount) : null,
      });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "A preset with this code already exists." });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Preset not found" });
      }
      logError("PUT /gift-cards/presets/[id] error", err);
      return res.status(500).json({ error: "Failed to update preset" });
    }
  }

  if (req.method === "DELETE") {
    try {
      await prisma.giftCardPreset.update({
        where: { id },
        data: { isActive: false, updatedBy: session.user?.email || null },
      });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Preset not found" });
      }
      logError("DELETE /gift-cards/presets/[id] error", err);
      return res.status(500).json({ error: "Failed to deactivate preset" });
    }
  }

  res.setHeader("Allow", ["PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
});
