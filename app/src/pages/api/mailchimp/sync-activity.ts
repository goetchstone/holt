// /app/src/pages/api/mailchimp/sync-activity.ts

import type { NextApiRequest, NextApiResponse } from "next";
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

  const { campaignId } = req.body;
  if (!campaignId) return res.status(400).json({ error: "Missing campaignId" });
  // Mailchimp campaign ids are short alphanumeric strings (e.g. "42694e9e57").
  // Validate before interpolating into the upstream API URL — closes the
  // CodeQL js/request-forgery finding on line ~40 by preventing path
  // traversal (e.g. "../lists/leak") inside the Mailchimp host.
  if (typeof campaignId !== "string" || !/^[a-z0-9]+$/.test(campaignId)) {
    return res.status(400).json({ error: "Invalid campaignId format" });
  }

  let offset = 0;
  const count = 1000;
  let totalSynced = 0;

  try {
    while (true) {
      const url = `${BASE_URL}/reports/${campaignId}/email-activity?offset=${offset}&count=${count}`;

      let response;
      try {
        response = await axios.get(url, authHeader);
      } catch (error: unknown) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = error.response.headers["retry-after"];
          const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RATE_LIMIT_DELAY_MS;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw error;
      }

      const emails = response.data.emails || [];
      if (emails.length === 0) break;

      for (const e of emails) {
        const email = e.email_address;
        const customer = await prisma.customer.findFirst({ where: { email } });

        for (const act of e.activity || []) {
          await prisma.mailchimpActivity.upsert({
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
          totalSynced++;
        }
      }

      offset += count;
    }

    res.status(200).json({ success: true, totalSynced });
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      const retryAfter = err.response.headers["retry-after"];
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RATE_LIMIT_DELAY_MS;
      return res.status(429).json({
        error: "Mailchimp rate limit reached",
        retryAfterMs: waitMs,
      });
    }
    logError("Mailchimp sync error", err);
    res.status(500).json({ error: "Sync failed" });
  }
}
