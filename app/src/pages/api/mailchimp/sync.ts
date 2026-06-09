// /app/src/pages/api/mailchimp/sync.ts

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

const authHeader = {
  headers: {
    Authorization: `apikey ${MAILCHIMP_API_KEY}`,
  },
};

const RATE_LIMIT_DELAY_MS = 5000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") return res.status(405).end();

  const full = req.query.full === "true" || req.body?.full === true;

  try {
    let sinceSendTime: string | null = null;

    if (!full) {
      // Find the most recent sentAt from already-synced campaigns
      const latest = await prisma.mailchimpCampaign.findFirst({
        where: { sentAt: { not: null } },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      });
      if (latest?.sentAt) {
        sinceSendTime = latest.sentAt.toISOString();
      }
    }

    let url = `${BASE_URL}/campaigns?count=1000&sort_field=send_time&sort_dir=DESC`;
    if (sinceSendTime) {
      url += `&since_send_time=${sinceSendTime}`;
    }

    const response = await axios.get(url, authHeader);
    const campaigns = response.data.campaigns;

    let synced = 0;
    for (const c of campaigns) {
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
      synced++;
    }

    res.status(200).json({ synced, incremental: !full });
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      const retryAfter = error.response.headers["retry-after"];
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RATE_LIMIT_DELAY_MS;
      return res.status(429).json({
        error: "Mailchimp rate limit reached",
        retryAfterMs: waitMs,
      });
    }
    logError("Failed to sync campaigns", error);
    res.status(500).json({ error: "Campaign sync failed" });
  }
}
