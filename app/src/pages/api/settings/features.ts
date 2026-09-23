// /app/src/pages/api/settings/features.ts
//
// Returns the deployment's resolved feature-module map (key -> enabled) from
// AppSettings, merged with catalog defaults. Used by the client nav to hide
// modules a tenant has switched off. Requires a session because the nav is
// only rendered to signed-in users; the values aren't sensitive (just which
// optional modules are active).

import { requirePermission } from "@/lib/auth/requireAuth";
import type { NextApiRequest, NextApiResponse } from "next";
import { getAppSettings } from "@/lib/appSettings";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const settings = await getAppSettings();
    return res.status(200).json({ features: settings.features });
  } catch (err) {
    logError("Failed to load feature flags", err);
    return res.status(500).json({ error: "Failed to load feature flags" });
  }
}

export default requirePermission("staff.self", handler);
