// /app/src/pages/api/mailchimp/campaigns/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { mailchimpDatacenter, mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";

const mailchimpApiKey = process.env.MAILCHIMP_API_KEY as string;
const dc = mailchimpDatacenter(mailchimpApiKey) ?? "";
const baseUrl = mailchimpBaseUrl(dc);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
