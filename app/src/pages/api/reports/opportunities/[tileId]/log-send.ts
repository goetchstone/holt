// /app/src/pages/api/reports/opportunities/[tileId]/log-send.ts
//
// POST /api/reports/opportunities/[tileId]/log-send
// Body: { customerIds: number[], notes?: string }
//
// Records that the user ran a campaign against these customer IDs for this
// tile. Drives the "last sent N days ago" subline on the hub and the 30-day
// dedup filter on the drill list. Explicit action (not inferred from a
// CSV-click) so the log stays honest.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { getTileById } from "@/lib/opportunityTiles";

const MAX_CUSTOMERS_PER_LOG = 10000;

export interface LogSendRequestBody {
  customerIds: number[];
  notes?: string;
}

export interface LogSendResponse {
  logged: number;
  sentAt: string;
}

export default requireAuthWithRole(
  ["MANAGER", "MARKETING", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end();
    }

    const tileId = req.query.tileId as string;
    if (!getTileById(tileId)) {
      return res.status(404).json({ error: "Unknown tile" });
    }

    const { customerIds, notes } = (req.body || {}) as LogSendRequestBody;
    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return res.status(400).json({ error: "customerIds must be a non-empty array" });
    }
    if (customerIds.length > MAX_CUSTOMERS_PER_LOG) {
      return res
        .status(400)
        .json({ error: `customerIds length exceeds cap (${MAX_CUSTOMERS_PER_LOG})` });
    }
    if (!customerIds.every((id) => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: "customerIds must be positive integers" });
    }

    const sentBy = session.user?.email ?? null;
    const sentAt = new Date();

    try {
      // De-duplicate the payload just in case the UI passed the same id twice.
      const uniqueIds = Array.from(new Set(customerIds));

      const result = await prisma.campaignTarget.createMany({
        data: uniqueIds.map((customerId) => ({
          tileId,
          customerId,
          sentAt,
          sentBy,
          notes: notes?.trim() || null,
        })),
      });

      return res.status(201).json({
        logged: result.count,
        sentAt: sentAt.toISOString(),
      });
    } catch (err: unknown) {
      logError("Opportunities log-send failed", err);
      return res.status(500).json({ error: "Failed to log campaign send" });
    }
  },
);
