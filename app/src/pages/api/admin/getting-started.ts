// /app/src/pages/api/admin/getting-started.ts
//
// GET: the getting-started checklist (lib/gettingStarted.ts) -- what this store
// still has to configure before its first sale. Read by the sidebar to badge
// the Admin entry while anything remains; the Admin hub renders the same list
// server-side through the same loader.
//
// Gated like its sibling /api/admin/settings ("admin.settings"), and like the
// Admin hub page that shows the full card: the items describe the settings an
// administrator makes.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { loadGettingStarted } from "@/lib/gettingStartedServer";
import { remainingItems } from "@/lib/gettingStarted";

export default requirePermission(
  "admin.settings",
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      const items = await loadGettingStarted();
      return res.json({ items, remaining: remainingItems(items).length });
    } catch (err) {
      logError("GET /api/admin/getting-started failed", err);
      return res.status(500).json({ error: "Failed to load the getting-started checklist" });
    }
  },
);
