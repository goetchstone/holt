// /app/src/pages/api/admin/config/changes.ts
//
// GET ?page=&limit= -> recent ConfigChangeLog rows, newest first. The audit
// view: when, who, from which door (source: "cli:config/local/x.yaml" or
// "gui"), what action, what changed. Append-only table, so this is a plain
// paginated read with a capped page size -- no filter parameters yet, since
// the whole log is small enough per docs/domains/config-presets.md's audit
// trail section to page through directly.
//
// ADMIN only (repo rule 42).

import type { NextApiRequest, NextApiResponse } from "next";

import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type { ChangesResponse } from "@/lib/config/presetApiTypes";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default requirePermission(
  "admin.config",
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const page = Math.max(1, parsePositiveInt(req.query.page, 1));
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parsePositiveInt(req.query.limit, DEFAULT_LIMIT)),
    );
    const skip = (page - 1) * limit;

    try {
      const [rows, total] = await Promise.all([
        prisma.configChangeLog.findMany({
          orderBy: { created: "desc" },
          skip,
          take: limit,
        }),
        prisma.configChangeLog.count(),
      ]);

      const body: ChangesResponse = {
        changes: rows.map((r) => ({
          id: r.id,
          presetKind: r.presetKind,
          presetName: r.presetName,
          action: r.action,
          source: r.source,
          summary: r.summary,
          actor: r.actor,
          created: r.created.toISOString(),
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
      return res.status(200).json(body);
    } catch (err) {
      logError("GET /api/admin/config/changes failed", err);
      return res.status(500).json({ error: "Failed to load change history" });
    }
  },
);
