// /app/src/pages/api/admin/automations/[key].ts
//
// GAP-37. PUT { isActive, frequency, everyMinutes, hour, weekday } saves whether an
// automation runs and when (lib/automations/settings.ts). POST runs it now, whatever
// that says, and answers what it did. Both answer the row for the screen.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { isAutomationKey } from "@/lib/automations/catalog";
import { runAutomationNow } from "@/lib/automations/runner";
import {
  AutomationSettingError,
  getAutomationSettings,
  saveAutomationSetting,
} from "@/lib/automations/settings";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { key } = req.query;
  try {
    if (req.method === "PUT") {
      const actor = session.user?.email ?? null;
      return res.status(200).json(await saveAutomationSetting(prisma, key, req.body, actor));
    }
    if (req.method === "POST") {
      if (!isAutomationKey(key)) return res.status(404).json({ error: "No such automation." });
      const result = await runAutomationNow(key);
      if (result.status === "ALREADY_RUNNING") {
        return res.status(409).json({ error: "It's already running." });
      }
      const row = (await getAutomationSettings()).find((r) => r.key === key);
      return res.status(200).json(row);
    }
    res.setHeader("Allow", "PUT, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    if (err instanceof AutomationSettingError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("/api/admin/automations/[key] error", err, { key: String(key) });
    return res.status(500).json({ error: "Couldn't do that to the automation." });
  }
}

export default requirePermission("admin.automations", handler);
