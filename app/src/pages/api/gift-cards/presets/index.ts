// /app/src/pages/api/gift-cards/presets/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default requireAuth(async (req, res) => {
  if (req.method === "GET") {
    try {
      const presets = await prisma.giftCardPreset.findMany({
        orderBy: { sortOrder: "asc" },
      });
      const result = presets.map((p) => ({
        ...p,
        amount: p.amount !== null ? Number(p.amount) : null,
      }));
      return res.status(200).json(result);
    } catch (err) {
      logError("GET /gift-cards/presets error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
    return requireAuthWithRole(["MANAGER", "ADMIN"], async (_req, _res, session) => {
      const { code, amount, label, sortOrder } = req.body;

      if (!code || !label) {
        return res.status(400).json({ error: "Code and label are required" });
      }

      try {
        const preset = await prisma.giftCardPreset.create({
          data: {
            code: code.toUpperCase().trim(),
            amount: amount !== null && amount !== undefined ? amount : null,
            label,
            sortOrder: sortOrder ?? 0,
            createdBy: session.user?.email || null,
          },
        });
        return res.status(201).json({
          ...preset,
          amount: preset.amount !== null ? Number(preset.amount) : null,
        });
      } catch (err: unknown) {
        if (getErrorCode(err) === "P2002") {
          return res.status(409).json({ error: "A preset with this code already exists." });
        }
        logError("POST /gift-cards/presets error", err);
        return res.status(500).json({ error: "Failed to create preset" });
      }
    })(req, res);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
});
