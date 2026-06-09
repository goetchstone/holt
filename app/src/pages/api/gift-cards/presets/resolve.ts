// /app/src/pages/api/gift-cards/presets/resolve.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

export default requireAuth(async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const code = ((req.query.code as string) || "").toUpperCase().trim();
  if (!code) {
    return res.status(400).json({ error: "Code query parameter is required" });
  }

  try {
    const preset = await prisma.giftCardPreset.findFirst({
      where: { code, isActive: true },
    });

    if (!preset) {
      return res.status(404).json({ error: "No active preset found for this code" });
    }

    return res.status(200).json({
      ...preset,
      amount: preset.amount !== null ? Number(preset.amount) : null,
    });
  } catch (err) {
    logError("GET /gift-cards/presets/resolve error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
