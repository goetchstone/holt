// /app/src/pages/api/portal/returns/request.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";

// 10 requests per minute per IP -- returns submission should be infrequent
const limiter = rateLimit({ windowMs: 60_000, maxRequests: 10 });

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { portalToken, reason, reasonNotes, lineItemId } = req.body;

  if (!portalToken || typeof portalToken !== "string") {
    return res.status(400).json({ error: "portalToken is required" });
  }

  if (!reason || typeof reason !== "string") {
    return res.status(400).json({ error: "reason is required" });
  }

  try {
    const existing = await prisma.return.findUnique({
      where: { portalToken },
    });

    if (!existing) {
      return res.status(404).json({ error: "Invalid or expired return token" });
    }

    if (existing.status !== "INITIATED") {
      return res.status(409).json({ error: "Return is no longer in a submittable state" });
    }

    if (!existing.portalRequestedAt) {
      return res.status(409).json({ error: "Return portal link has not been activated" });
    }

    const data: Record<string, unknown> = {
      reason,
      customerNotes: reasonNotes || null,
    };

    if (lineItemId && typeof lineItemId === "number") {
      data.lineItemId = lineItemId;
    }

    const updated = await prisma.return.update({
      where: { portalToken },
      data,
    });

    return res.status(200).json(updated);
  } catch (error) {
    logError("Portal return request error", error);
    return res.status(500).json({ error: "Failed to submit return request" });
  }
});
