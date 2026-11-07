// /app/src/pages/api/mailchimp/delete-all.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { logError } from "@/lib/logger";
export default requirePermission(
  "admin.data",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "DELETE") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      // Delete in correct order due to foreign key constraints
      await prisma.mailchimpActivity.deleteMany({});
      await prisma.mailchimpCampaignStats.deleteMany({});
      const { count } = await prisma.mailchimpCampaign.deleteMany({});
      await auditLog("BULK_DELETED", auditActor(session), {
        summary: `All ${count} email campaigns deleted, with their activity and stats`,
        details: { table: "MailchimpCampaign", deleted: count },
      });

      return res.status(200).json({ message: "All Mailchimp data cleared successfully." });
    } catch (error: unknown) {
      logError("Failed to clear Mailchimp data", error);
      return res.status(500).json({ error: "Failed to clear data" });
    }
  },
);
