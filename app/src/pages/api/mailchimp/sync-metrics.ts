// /app/src/pages/api/mailchimp/sync-metrics.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { mailchimpDatacenter, mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY || "";
const DATACENTER = mailchimpDatacenter(MAILCHIMP_API_KEY) ?? "";
const BASE_URL = mailchimpBaseUrl(DATACENTER);

const authHeader = { headers: { Authorization: `apikey ${MAILCHIMP_API_KEY}` } };

const RATE_LIMIT_DELAY_MS = 5000;
const INTER_REQUEST_DELAY_MS = 200;
const MAX_RATE_LIMIT_RETRIES = 2;

interface ParsedReport {
  emailsSent: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  bounces: number;
  unsubscribed: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseReport(report: any): ParsedReport {
  const safeInt = (val: unknown): number => (typeof val === "number" ? val : 0);

  return {
    emailsSent: safeInt(report.emails_sent),
    opens: safeInt(report.opens?.opens_total),
    uniqueOpens: safeInt(report.opens?.unique_opens),
    clicks: safeInt(report.clicks?.clicks_total),
    uniqueClicks: safeInt(report.clicks?.unique_subscriber_clicks),
    bounces: safeInt(report.bounces?.hard_bounces) + safeInt(report.bounces?.soft_bounces),
    unsubscribed: safeInt(report.unsubscribed),
  };
}

async function fetchReportWithRetry(campaignId: string): Promise<ParsedReport> {
  let retries = 0;
  while (true) {
    try {
      const { data } = await axios.get(`${BASE_URL}/reports/${campaignId}`, authHeader);
      return parseReport(data);
    } catch (err: unknown) {
      if (
        axios.isAxiosError(err) &&
        err.response?.status === 429 &&
        retries < MAX_RATE_LIMIT_RETRIES
      ) {
        const retryAfter = err.response.headers["retry-after"];
        const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RATE_LIMIT_DELAY_MS;
        await new Promise((r) => setTimeout(r, waitMs));
        retries++;
        continue;
      }
      throw err;
    }
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") return res.status(405).end();

  const full = req.query.full === "true" || req.body?.full === true;

  try {
    let campaignIds: string[];

    if (full) {
      const campaigns = await prisma.mailchimpCampaign.findMany({ select: { id: true } });
      campaignIds = campaigns.map((c) => c.id);
    } else {
      // Incremental: only campaigns missing stats
      const allCampaigns = await prisma.mailchimpCampaign.findMany({ select: { id: true } });
      const existingStats = await prisma.mailchimpCampaignStats.findMany({
        select: { campaignId: true },
      });
      const statsSet = new Set(existingStats.map((s) => s.campaignId));
      campaignIds = allCampaigns.filter((c) => !statsSet.has(c.id)).map((c) => c.id);
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
        await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
      } catch (err: unknown) {
        logError("Failed to sync metrics for campaign", err, { campaignId });
        failed.push(campaignId);
      }
    }

    res.status(200).json({ updated, failed, incremental: !full });
  } catch (err) {
    logError("Metrics sync failed", err);
    res.status(500).json({ error: "Sync failed" });
  }
}
