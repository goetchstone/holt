// /app/src/pages/api/automations/mailchimp-sync.ts
//
// Orchestrator endpoint for the automated Mailchimp sync pipeline. Runs
// every 6 hours from the Synology Task Scheduler (curl + AUTO_IMPORT_API_KEY)
// or on-demand from the admin page (NextAuth session).
//
// Phases, each wrapped in its own try/catch so a later phase failing doesn't
// erase the earlier phase's work:
//
//   1. Campaigns      — cheap, always incremental
//   2. Metrics        — campaigns sent in last 30 days
//   3. Activity       — campaigns sent in last 14 days
//   4. Lead ingestor  — converts newly-synced activity into leads
//
// Writes one MailchimpSyncLog row per run with status SUCCESS / PARTIAL / FAILED.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import { logError, logger } from "@/lib/logger";
import { runCampaignSync, runMetricsSync, runActivitySync } from "@/lib/mailchimpSyncRunners";
import { ingestNewMailchimpActivityAsLeads } from "@/lib/mailchimpLeadIngestor";

function isAuthorized(
  req: NextApiRequest,
  session: { user?: { email?: string | null } } | null,
): boolean {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey && req.headers.authorization === `Bearer ${apiKey}`) return true;
  if (session?.user?.email) return true;
  return false;
}

type Phase = "campaigns" | "metrics" | "activity" | "ingest-leads" | "all";

const VALID_PHASES: Phase[] = ["campaigns", "metrics", "activity", "ingest-leads", "all"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!isAuthorized(req, session)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const phaseParam = (req.query.phase as string) || "all";
  if (!VALID_PHASES.includes(phaseParam as Phase)) {
    return res.status(400).json({
      error: `phase must be one of: ${VALID_PHASES.join(", ")}`,
    });
  }
  const phase = phaseParam as Phase;

  const runId = randomUUID();
  const startedAt = new Date();
  // Phase-level exceptions that should flip the run status. Per-campaign
  // failures go in `warnings` instead -- they're expected noise and
  // shouldn't downgrade an otherwise-successful run.
  const fatalErrors: string[] = [];
  const warnings: string[] = [];

  let campaignsUpserted = 0;
  let metricsUpdated = 0;
  let activitiesInserted = 0;
  let leadsCreated = 0;
  let leadsUpdated = 0;

  // Timestamp of the previous successful activity ingestion — used so the
  // ingestor only scans activity rows inserted since then.
  const lastSuccess = await prisma.mailchimpSyncLog.findFirst({
    where: { kind: "mailchimp-sync", status: { in: ["SUCCESS", "PARTIAL"] } },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  const sinceTimestamp = lastSuccess?.finishedAt ?? null;

  // Phase 1: campaigns (runs for "all" and "campaigns")
  if (phase === "all" || phase === "campaigns") {
    try {
      const r = await runCampaignSync();
      campaignsUpserted = r.upserted;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fatalErrors.push(`campaigns: ${msg}`);
      logError("mailchimp-sync campaigns phase failed", err);
    }
  }

  // Phase 2: metrics
  if (phase === "all" || phase === "metrics") {
    try {
      const r = await runMetricsSync({ recentDays: 30 });
      metricsUpdated = r.updated;
      // Per-campaign failures are expected (Mailchimp rate limits,
      // campaigns deleted since our last sync, etc.) -- record them as
      // a warning, not a phase error. Status stays SUCCESS.
      if (r.failed.length) warnings.push(`metrics failed for ${r.failed.length} campaign(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fatalErrors.push(`metrics: ${msg}`);
      logError("mailchimp-sync metrics phase failed", err);
    }
  }

  // Phase 3: activity
  if (phase === "all" || phase === "activity") {
    try {
      const r = await runActivitySync({ recentDays: 14 });
      activitiesInserted = r.inserted;
      if (r.failed.length) warnings.push(`activity failed for ${r.failed.length} campaign(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fatalErrors.push(`activity: ${msg}`);
      logError("mailchimp-sync activity phase failed", err);
    }
  }

  // Phase 4: lead ingestion
  if (phase === "all" || phase === "ingest-leads") {
    try {
      const r = await ingestNewMailchimpActivityAsLeads({ sinceTimestamp });
      leadsCreated = r.leadsCreated;
      leadsUpdated = r.leadsUpdated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fatalErrors.push(`lead ingestion: ${msg}`);
      logError("mailchimp-sync lead-ingestion phase failed", err);
    }
  }

  const finishedAt = new Date();
  // Status reflects phase-level errors only. A run that processed 773 of
  // 774 campaigns cleanly is SUCCESS, not PARTIAL, even though one
  // campaign failed its per-campaign API call.
  const status: "SUCCESS" | "PARTIAL" | "FAILED" =
    fatalErrors.length === 0
      ? "SUCCESS"
      : campaignsUpserted + metricsUpdated + activitiesInserted + leadsCreated > 0
        ? "PARTIAL"
        : "FAILED";
  // Persist both fatal errors and warnings in the same `errors` column
  // so the existing UI continues to display them. Fatals first so the
  // log row makes the severe stuff obvious.
  const errors = [...fatalErrors, ...warnings];

  const log = await prisma.mailchimpSyncLog.create({
    data: {
      runId,
      kind: phase === "all" ? "mailchimp-sync" : `mailchimp-sync:${phase}`,
      status,
      campaignsUpserted,
      metricsUpdated,
      activitiesInserted,
      leadsCreated,
      leadsUpdated,
      errors,
      startedAt,
      finishedAt,
    },
  });

  logger.info("mailchimp-sync orchestrator complete", {
    runId,
    phase,
    status,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    campaignsUpserted,
    metricsUpdated,
    activitiesInserted,
    leadsCreated,
    leadsUpdated,
  });

  return res.status(status === "FAILED" ? 500 : 200).json({
    runId,
    phase,
    status,
    campaignsUpserted,
    metricsUpdated,
    activitiesInserted,
    leadsCreated,
    leadsUpdated,
    errors,
    logId: log.id,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });
}
