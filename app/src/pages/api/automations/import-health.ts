// /app/src/pages/api/automations/import-health.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const [lastSuccess, lastRun, recentUnmapped] = await Promise.all([
    prisma.autoImportLog.findFirst({
      where: { status: "success" },
      orderBy: { created: "desc" },
      select: { created: true, importType: true, runId: true },
    }),

    prisma.autoImportLog.findFirst({
      orderBy: { created: "desc" },
      select: { created: true, status: true, runId: true },
    }),

    // Find recent stock imports that have unmapped locations in resultSummary
    prisma.autoImportLog.findMany({
      where: {
        importType: "stock",
        status: "success",
        resultSummary: { not: Prisma.JsonNull },
      },
      orderBy: { created: "desc" },
      take: 1,
      select: { resultSummary: true, created: true },
    }),
  ]);

  const now = new Date();
  const lastSuccessDate = lastSuccess?.created ?? null;
  const hoursSinceSuccess = lastSuccessDate
    ? (now.getTime() - new Date(lastSuccessDate).getTime()) / (1000 * 60 * 60)
    : null;

  // Extract unmapped locations from the most recent stock import
  let unmappedLocations: string[] = [];
  if (recentUnmapped.length > 0) {
    const summary = recentUnmapped[0].resultSummary as Record<string, unknown> | null;
    if (summary && Array.isArray(summary.unmappedLocations)) {
      unmappedLocations = summary.unmappedLocations as string[];
    }
  }

  return res.status(200).json({
    lastSuccessfulRun: lastSuccessDate,
    lastRun: lastRun?.created ?? null,
    lastRunStatus: lastRun?.status ?? null,
    hoursSinceSuccess: hoursSinceSuccess !== null ? Math.round(hoursSinceSuccess * 10) / 10 : null,
    isStale: hoursSinceSuccess === null || hoursSinceSuccess > 24,
    unmappedLocations,
  });
}
