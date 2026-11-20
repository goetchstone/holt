// /app/src/pages/api/mailchimp/campaigns/index.ts

import { requirePermission } from "@/lib/auth/requireAuth";
import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { logError } from "@/lib/logger";
import { mailchimpDatacenter, mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";

const mailchimpApiKey = process.env.MAILCHIMP_API_KEY as string;
const dc = mailchimpDatacenter(mailchimpApiKey);
const baseUrl = mailchimpBaseUrl(dc ?? "");

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // The Leads screen asks on every load. With no usable key there is nothing to
  // fetch, and nothing the caller did wrong: say so with an empty list, instead
  // of requesting https://.api.mailchimp.com and answering its DNS failure (and
  // an ops alert) with a 500.
  if (!dc) return res.status(200).json({ campaigns: [], configured: false });
  try {
    const response = await axios.get(`${baseUrl}/campaigns`, {
      auth: {
        username: "anystring",
        password: mailchimpApiKey,
      },
      params: {
        count: 10,
        sort_field: "send_time",
        sort_dir: "DESC",
      },
    });

    const campaigns = response.data.campaigns.map((campaign: any) => ({
      id: campaign.id,
      name: campaign.settings.title,
      subject: campaign.settings.subject_line,
      send_time: campaign.send_time,
      emails_sent: campaign.emails_sent,
      status: campaign.status,
    }));

    res.status(200).json({ campaigns });
  } catch (error) {
    logError("Error fetching Mailchimp campaigns", error);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
}

export default requirePermission("reporting.read", handler);
