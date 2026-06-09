// /app/src/pages/api/mailchimp/delete-all.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Delete in correct order due to foreign key constraints
    await prisma.mailchimpActivity.deleteMany({});
    await prisma.mailchimpCampaignStats.deleteMany({});
    await prisma.mailchimpCampaign.deleteMany({});

    return res.status(200).json({ message: "All Mailchimp data cleared successfully." });
  } catch (error: unknown) {
    logError("Failed to clear Mailchimp data", error);
    return res
      .status(500)
      .json({ error: `Failed to clear data: ${getErrorMessage(error, "unknown error")}` });
  }
});
