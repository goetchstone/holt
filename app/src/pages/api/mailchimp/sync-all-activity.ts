// /app/src/pages/api/mailchimp/sync-all-activity.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { mailchimpDatacenter, mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";

const RATE_LIMIT_DELAY_MS = 5000;
const INTER_CAMPAIGN_DELAY_MS = 1000;
const INTER_PAGE_DELAY_MS = 500;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") return res.status(405).end();

  const full = req.query.full === "true" || req.body?.full === true;
  // Cap campaigns per invocation so the request fits inside Nginx's 300s
  // proxy_read_timeout. 740+ historical campaigns at ~2-4s each blow the
  // limit; chunking lets the admin UI call this endpoint repeatedly until
  // `remaining` reaches 0. Default 40 campaigns / call (generous margin).
  const maxCampaigns = Math.max(
    1,
    Math.min(500, Number(req.query.maxCampaigns ?? req.body?.maxCampaigns ?? 40)),
  );

  const apiKey = process.env.MAILCHIMP_API_KEY;
  const serverPrefix = mailchimpDatacenter(apiKey);
  if (!serverPrefix) {
    return res.status(400).json({
      error: "Mailchimp not configured: API key missing or malformed (expected <key>-<datacenter>)",
    });
  }
  const baseUrl = mailchimpBaseUrl(serverPrefix);

  try {
    let candidateCampaigns: { id: string }[];

    if (full) {
      // Full sync: reprocess every campaign, ignoring the synced marker.
      candidateCampaigns = await prisma.mailchimpCampaign.findMany({
        select: { id: true },
        orderBy: { sentAt: "desc" },
      });
    } else {
      // Incremental: skip campaigns we've already asked Mailchimp about.
      // Prior version filtered "has zero MailchimpActivity rows" -- but a
      // campaign can legitimately have zero opens/clicks, so it kept
      // looping forever. `activityLastSyncedAt` is our "we tried" marker
      // regardless of whether Mailchimp returned anything.
      candidateCampaigns = await prisma.mailchimpCampaign.findMany({
        where: { activityLastSyncedAt: null },
        select: { id: true },
        orderBy: { sentAt: "desc" },
      });
    }

    const totalCandidates = candidateCampaigns.length;
    const campaigns = candidateCampaigns.slice(0, maxCampaigns);
    const remaining = Math.max(0, totalCandidates - campaigns.length);

    let totalSynced = 0;
    let campaignsSynced = 0;
    const failed: string[] = [];

    for (const campaign of campaigns) {
      let offset = 0;
      const count = 1000;

      while (true) {
        try {
          const response = await axios.get(`${baseUrl}/reports/${campaign.id}/email-activity`, {
            auth: { username: "anystring", password: apiKey || "" },
            params: { offset, count },
          });

          const emails = response.data.emails as Array<{
            email_address: string;
            activity: Array<{ action: string; timestamp: string }>;
          }>;
          if (!emails || emails.length === 0) break;

          for (const email of emails) {
            for (const act of email.activity) {
              try {
                await prisma.mailchimpActivity.upsert({
                  where: {
                    email_campaignId_action_timestamp: {
                      email: email.email_address,
                      campaignId: campaign.id,
                      action: act.action,
                      timestamp: new Date(act.timestamp),
                    },
                  },
                  update: {},
                  create: {
                    email: email.email_address,
                    campaignId: campaign.id,
                    action: act.action,
                    timestamp: new Date(act.timestamp),
                    customerId: null,
                  },
                });
                totalSynced++;
              } catch (upsertErr) {
                logError("Failed upsert during activity sync", upsertErr, {
                  campaignId: campaign.id,
                });
              }
            }
          }

          offset += count;
          await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
        } catch (error: unknown) {
          if (axios.isAxiosError(error) && error.response?.status === 429) {
            const retryAfter = error.response.headers["retry-after"];
            const waitMs = retryAfter
              ? Number.parseInt(retryAfter, 10) * 1000
              : RATE_LIMIT_DELAY_MS;
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          logError("Error syncing campaign activity", error, { campaignId: campaign.id });
          failed.push(campaign.id);
          break;
        }
      }
      // Mark this campaign as processed regardless of whether Mailchimp
      // returned any activity rows. Without this marker the incremental
      // selector loops forever on empty campaigns.
      if (!failed.includes(campaign.id)) {
        await prisma.mailchimpCampaign.update({
          where: { id: campaign.id },
          data: { activityLastSyncedAt: new Date() },
        });
      }
      campaignsSynced++;
      await new Promise((r) => setTimeout(r, INTER_CAMPAIGN_DELAY_MS));
    }

    return res.status(200).json({
      message: `Activity sync chunk complete — ${campaignsSynced} campaigns processed`,
      campaignsSynced,
      totalActivities: totalSynced,
      failed,
      incremental: !full,
      remaining,
      done: remaining === 0,
    });
  } catch (error) {
    logError("Activity sync failed", error);
    return res.status(500).json({ error: "Failed to sync activity" });
  }
}
