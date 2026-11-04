// /app/src/pages/api/customer-messages/[kind].ts
//
// GAP-13: PUT { isActive, subject, body, includeOrderLink, offsetDays,
// sendHour, linkUrl } saves one automatic customer message as the store set
// it up (lib/messages/settings.ts saveMessageSetting). Switching it on starts
// it from now: nothing already past is sent. admin.settings.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { MessageSettingError, saveMessageSetting } from "@/lib/messages/settings";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const setting = await saveMessageSetting(
      prisma,
      req.query.kind,
      req.body,
      session.user?.email ?? null,
    );
    return res.status(200).json(setting);
  } catch (err) {
    if (err instanceof MessageSettingError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("PUT /api/customer-messages/[kind] error", err);
    return res.status(500).json({ error: "Failed to save the message" });
  }
}

export default requirePermission("admin.settings", handler);
