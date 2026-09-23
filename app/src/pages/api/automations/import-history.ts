// /app/src/pages/api/automations/import-history.ts

import { requirePermission } from "@/lib/auth/requireAuth";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "50"), 10)));
  const skip = (page - 1) * limit;

  const statusFilter = req.query.status as string | undefined;

  const where = statusFilter ? { status: statusFilter } : {};

  const [logs, total] = await Promise.all([
    prisma.autoImportLog.findMany({
      where,
      orderBy: { created: "desc" },
      skip,
      take: limit,
    }),
    prisma.autoImportLog.count({ where }),
  ]);

  return res.status(200).json({
    logs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

export default requirePermission("admin.data", handler);
