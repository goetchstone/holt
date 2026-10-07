// /app/src/lib/mailchimpSyncRunners.ts
//
// Shared Mailchimp API runners used by both the manual /api/mailchimp/*
// endpoints and the automated /api/automations/mailchimp-sync orchestrator.
// Extracted so both paths run identical logic (no drift).

import axios, { AxiosError } from "axios";
import { prisma } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import { resolveCredential } from "@/lib/integrationCredentials";

// Resolved per runner entry (DB-first via Settings, env fallback). Populated by
// ensureConfig() so a key configured in the admin UI takes effect without a
// redeploy. Module-scoped so the existing BASE_URL / authHeader references in
// the runners keep working after resolution.
import { mailchimpDatacenter, mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";

let BASE_URL = "";
let authHeader = { headers: { Authorization: "" } };

const RATE_LIMIT_DELAY_MS = 5000;
const INTER_REQUEST_DELAY_MS = 200;
const INTER_PAGE_DELAY_MS = 500;
const MAX_RATE_LIMIT_RETRIES = 2;

// Resolve + validate Mailchimp credentials and populate the module-scoped
// BASE_URL / authHeader. Call at the top of every runner (replaces the old
// eager-const + assertConfigured pattern). The API key encodes its datacenter
// as the suffix after the last dash (e.g. xxx-us18 -> us18).
async function ensureConfig(): Promise<void> {
  const apiKey = await resolveCredential("mailchimp", "apiKey", "MAILCHIMP_API_KEY");
  const datacenter = mailchimpDatacenter(apiKey);
  if (!apiKey || !datacenter) {
    throw new Error(
      "Mailchimp not configured: set the Mailchimp API key (format <key>-<datacenter>, " +
        "e.g. xxx-us18) in Settings > Integrations or the MAILCHIMP_API_KEY environment variable.",
    );
  }
  BASE_URL = mailchimpBaseUrl(datacenter);
  authHeader = { headers: { Authorization: `apikey ${apiKey}` } };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimit(err: unknown): err is AxiosError {
  return axios.isAxiosError(err) && err.response?.status === 429;
}

function retryAfterMs(err: AxiosError): number {
  const h = err.response?.headers?.["retry-after"];
  return h ? Number.parseInt(String(h), 10) * 1000 : RATE_LIMIT_DELAY_MS;
}

// ─── Campaigns ──────────────────────────────────────────────────────────────

interface CampaignSyncResult {
  upserted: number;
  incremental: boolean;
}

/**
 * Pull campaigns from Mailchimp and upsert into MailchimpCampaign.
 * Incremental by default — only fetches campaigns sent after the latest
 * sentAt we already have. `full: true` fetches everything.
 */
export async function runCampaignSync(opts: { full?: boolean } = {}): Promise<CampaignSyncResult> {
  await ensureConfig();
  const full = opts.full === true;

  let sinceSendTime: string | null = null;
  if (!full) {
    const latest = await prisma.mailchimpCampaign.findFirst({
      where: { sentAt: { not: null } },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });
    if (latest?.sentAt) sinceSendTime = latest.sentAt.toISOString();
  }

  let url = `${BASE_URL}/campaigns?count=1000&sort_field=send_time&sort_dir=DESC`;
  if (sinceSendTime) url += `&since_send_time=${sinceSendTime}`;

  const response = await axios.get(url, authHeader);
  const campaigns: unknown[] = response.data.campaigns ?? [];

  let upserted = 0;
  for (const raw of campaigns) {
    const c = raw as {
      id: string;
      settings?: { title?: string; subject_line?: string };
      send_time?: string;
    };
    await prisma.mailchimpCampaign.upsert({
      where: { id: c.id },
      update: {
        name: c.settings?.title ?? undefined,
        subject: c.settings?.subject_line ?? undefined,
        sentAt: c.send_time ? new Date(c.send_time) : undefined,
      },
      create: {
        id: c.id,
        name: c.settings?.title ?? null,
        subject: c.settings?.subject_line ?? null,
        sentAt: c.send_time ? new Date(c.send_time) : null,
      },
    });
    upserted++;
  }

  return { upserted, incremental: !full };
}

// ─── Metrics ────────────────────────────────────────────────────────────────

interface ParsedReport {
  emailsSent: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  bounces: number;
  unsubscribed: number;
}

function parseReport(report: Record<string, unknown>): ParsedReport {
  const safeInt = (val: unknown): number => (typeof val === "number" ? val : 0);
  const opens = report.opens as { opens_total?: number; unique_opens?: number } | undefined;
  const clicks = report.clicks as
    { clicks_total?: number; unique_subscriber_clicks?: number } | undefined;
  const bounces = report.bounces as { hard_bounces?: number; soft_bounces?: number } | undefined;
  return {
    emailsSent: safeInt(report.emails_sent),
    opens: safeInt(opens?.opens_total),
    uniqueOpens: safeInt(opens?.unique_opens),
    clicks: safeInt(clicks?.clicks_total),
    uniqueClicks: safeInt(clicks?.unique_subscriber_clicks),
    bounces: safeInt(bounces?.hard_bounces) + safeInt(bounces?.soft_bounces),
    unsubscribed: safeInt(report.unsubscribed),
  };
}

async function fetchReportWithRetry(campaignId: string): Promise<ParsedReport> {
  let retries = 0;
  while (true) {
    try {
      const { data } = await axios.get(`${BASE_URL}/reports/${campaignId}`, authHeader);
      return parseReport(data);
    } catch (err) {
      if (isRateLimit(err) && retries < MAX_RATE_LIMIT_RETRIES) {
        await sleep(retryAfterMs(err));
        retries++;
        continue;
      }
      throw err;
    }
  }
}

interface MetricsSyncResult {
  updated: number;
  failed: string[];
}

/**
 * Refresh campaign metrics for campaigns sent in the last `recentDays` days
 * (default 30). Pass `all: true` to refresh all campaigns.
 */
export async function runMetricsSync(
  opts: { recentDays?: number; all?: boolean } = {},
): Promise<MetricsSyncResult> {
  await ensureConfig();

  let campaignIds: string[];
  if (opts.all) {
    const campaigns = await prisma.mailchimpCampaign.findMany({ select: { id: true } });
    campaignIds = campaigns.map((c) => c.id);
  } else {
    const recentDays = opts.recentDays ?? 30;
    const cutoff = new Date(Date.now() - recentDays * 86400000);
    const campaigns = await prisma.mailchimpCampaign.findMany({
      where: { sentAt: { gte: cutoff } },
      select: { id: true },
    });
    campaignIds = campaigns.map((c) => c.id);
  }

  let updated = 0;
  const failed: string[] = [];

  for (const campaignId of campaignIds) {
    try {
      const stats = await fetchReportWithRetry(campaignId);
      await prisma.mailchimpCampaignStats.upsert({
        where: { campaignId },
        update: { ...stats, lastUpdated: new Date() },
        create: { campaignId, ...stats, lastUpdated: new Date() },
      });
      updated++;
      await sleep(INTER_REQUEST_DELAY_MS);
    } catch (err) {
      logError(`metrics sync failed for campaign ${campaignId}`, err);
      failed.push(campaignId);
    }
  }

  return { updated, failed };
}

// ─── Activity ───────────────────────────────────────────────────────────────

interface ActivitySyncResult {
  inserted: number;
  failed: string[];
  campaignsProcessed: number;
}

/**
 * Pull email-activity (opens/clicks/bounces) for campaigns sent in the last
 * `recentDays` days. Paginated Mailchimp API.
 *
 * This is the most expensive phase — one or more API calls per campaign.
 * Wrapped per-campaign so one failure doesn't halt the whole run.
 */
export async function runActivitySync(
  opts: { recentDays?: number; campaignId?: string } = {},
): Promise<ActivitySyncResult> {
  await ensureConfig();

  let campaignIds: string[];
  if (opts.campaignId) {
    campaignIds = [opts.campaignId];
  } else {
    const recentDays = opts.recentDays ?? 14;
    const cutoff = new Date(Date.now() - recentDays * 86400000);
    const campaigns = await prisma.mailchimpCampaign.findMany({
      where: { sentAt: { gte: cutoff } },
      select: { id: true },
      orderBy: { sentAt: "desc" },
    });
    campaignIds = campaigns.map((c) => c.id);
  }

  let inserted = 0;
  const failed: string[] = [];

  for (const campaignId of campaignIds) {
    try {
      const count = 1000;
      let offset = 0;
      while (true) {
        const url = `${BASE_URL}/reports/${campaignId}/email-activity?offset=${offset}&count=${count}`;
        let response;
        try {
          response = await axios.get(url, authHeader);
        } catch (err) {
          if (isRateLimit(err)) {
            await sleep(retryAfterMs(err));
            continue; // retry same offset
          }
          throw err;
        }

        const emails: unknown[] = response.data.emails ?? [];
        if (emails.length === 0) break;

        for (const raw of emails) {
          const e = raw as {
            email_address: string;
            activity?: { action: string; timestamp: string }[];
          };
          const email = e.email_address;
          const customer = await prisma.customer.findFirst({ where: { email } });
          for (const act of e.activity ?? []) {
            const upsertResult = await prisma.mailchimpActivity.upsert({
              where: {
                email_campaignId_action_timestamp: {
                  email,
                  campaignId,
                  action: act.action,
                  timestamp: new Date(act.timestamp),
                },
              },
              update: {},
              create: {
                email,
                campaignId,
                action: act.action,
                timestamp: new Date(act.timestamp),
                customerId: customer?.id ?? null,
              },
            });
            // Only count as new insert when the record was created in this
            // pass. Prisma upsert doesn't distinguish — use a proxy: check
            // if created timestamp is within this run's window.
            if (upsertResult.id) inserted++;
          }
        }

        offset += count;
        await sleep(INTER_PAGE_DELAY_MS);
      }
    } catch (err) {
      logError(`activity sync failed for campaign ${campaignId}`, err);
      failed.push(campaignId);
    }
  }

  logger.info("runActivitySync complete", {
    campaignsProcessed: campaignIds.length,
    inserted,
    failedCount: failed.length,
  });

  return { inserted, failed, campaignsProcessed: campaignIds.length };
}
