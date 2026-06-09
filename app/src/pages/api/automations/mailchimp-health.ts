// /app/src/pages/api/automations/mailchimp-health.ts
//
// Quick status for the Mailchimp automation card on the admin page.
// Returns the last SUCCESS/PARTIAL/FAILED run and a `isStale` flag when
// no successful run has happened in the last 12 hours.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

// Daily cron cadence — allow one missed run before alarming.
const STALE_AFTER_HOURS = 36;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).end();

  const [lastRun, lastSuccess] = await Promise.all([
    prisma.mailchimpSyncLog.findFirst({
      where: { kind: "mailchimp-sync" },
      orderBy: { created: "desc" },
    }),
    prisma.mailchimpSyncLog.findFirst({
      where: { kind: "mailchimp-sync", status: { in: ["SUCCESS", "PARTIAL"] } },
      orderBy: { finishedAt: "desc" },
    }),
  ]);

  const now = Date.now();
  const lastSuccessAt = lastSuccess?.finishedAt?.getTime() ?? 0;
  const hoursSinceSuccess = lastSuccessAt ? (now - lastSuccessAt) / 3600000 : Infinity;
  const isStale = hoursSinceSuccess > STALE_AFTER_HOURS;

  return res.status(200).json({
    lastRun: lastRun
      ? {
          runId: lastRun.runId,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          campaignsUpserted: lastRun.campaignsUpserted,
          metricsUpdated: lastRun.metricsUpdated,
          activitiesInserted: lastRun.activitiesInserted,
          leadsCreated: lastRun.leadsCreated,
          leadsUpdated: lastRun.leadsUpdated,
          errors: lastRun.errors,
        }
      : null,
    lastSuccessAt: lastSuccess?.finishedAt ?? null,
    isStale,
    hoursSinceSuccess: isFinite(hoursSinceSuccess) ? Math.round(hoursSinceSuccess * 10) / 10 : null,
  });
}
