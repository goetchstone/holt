// /app/src/pages/api/automations/import-history.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
