// /app/src/pages/api/admin/buyer-drafts/buys/archive.ts
//
// Returns CLOSED buys with a pre-computed rollup (spent / # POs / #
// items) so the archive page renders without further client-side math.
//
// Per user direction 2026-05-13: closed buys disappear from the main
// `/app/admin/buyer-drafts` page (clean slate) but live here for historical
// reporting + drill-down. From the archive the user can jump to the
// performance report or back to the main page filtered to this Buy.
//
// ADMIN-only. GET only. Sorts most-recently-closed first.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  try {
    const rows = await prisma.buyerDraftBuy.findMany({
      where: { status: "CLOSED" },
      select: {
        id: true,
        name: true,
        season: true,
        year: true,
        status: true,
        budget: true,
        kickoff: true,
        // `updated` is the proxy for closedAt — we don't track
        // transition timestamps separately. Whenever the buyer flipped
        // the status to CLOSED, `updated` got bumped to that moment.
        updated: true,
        pos: {
          select: {
            items: { select: { qty: true, cost: true } },
            _count: { select: { items: true } },
          },
        },
        _count: { select: { pos: true } },
      },
      orderBy: [{ year: "desc" }, { updated: "desc" }],
    });

    const buys = rows.map((b) => {
      let spent = 0;
      let itemCount = 0;
      for (const po of b.pos) {
        itemCount += po._count.items;
        for (const it of po.items) {
          spent += Number(it.qty) * Number(it.cost.toString());
        }
      }
      return {
        id: b.id,
        name: b.name,
        season: b.season,
        year: b.year,
        status: b.status,
        budget: b.budget?.toString() ?? null,
        kickoff: b.kickoff?.toISOString() ?? null,
        closedAt: b.updated?.toISOString() ?? null,
        spent: Math.round(spent * 100) / 100,
        poCount: b._count.pos,
        itemCount,
      };
    });

    return res.status(200).json({ buys });
  } catch (err) {
    logError("buyer-drafts buys archive failed", err);
    return res.status(500).json({ error: "Failed to load archived buys" });
  }
});
