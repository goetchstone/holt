// /app/src/pages/api/sales/pipeline/bulk-archive.ts
//
// POST: archive all QUOTE orders created before a given date.
// Manager-only. Safe to run multiple times — skips already-archived quotes.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
interface BulkArchiveBody {
  before: string; // ISO date string — archive quotes with quoteDate/orderDate before this
  note?: string;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const staff = await prisma.staffMember.findUnique({
      where: { email: session.user?.email ?? undefined },
      select: { role: true },
    });
    if (staff?.role !== "MANAGER" && staff?.role !== "ADMIN")
      return res.status(403).json({ error: "Managers only" });

    const { before, note } = req.body as BulkArchiveBody;
    if (!before) return res.status(400).json({ error: "before is required" });

    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime())) return res.status(400).json({ error: "Invalid date" });

    // Count first so we can return a meaningful number
    const matching = await prisma.salesOrder.findMany({
      where: {
        status: "QUOTE",
        pipelineArchivedAt: null,
        OR: [{ quoteDate: { lt: cutoff } }, { quoteDate: null, orderDate: { lt: cutoff } }],
      },
      select: { id: true },
    });

    if (matching.length === 0) {
      return res.status(200).json({ archived: 0 });
    }

    const ids = matching.map((o) => o.id);
    const now = new Date();
    const archiveNote =
      note?.trim() || `Archived in bulk: created before ${cutoff.toLocaleDateString("en-US")}`;

    await prisma.salesOrder.updateMany({
      where: { id: { in: ids } },
      data: {
        pipelineArchivedAt: now,
        pipelineNote: archiveNote,
        updatedBy: session.user?.email ?? undefined,
      },
    });

    return res.status(200).json({ archived: ids.length });
  },
);
