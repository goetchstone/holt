// /app/src/pages/api/automations/source-readiness.ts
//
// GET -- can the active source adapter run right now?
//
// Separate from source-import so the admin page can answer "is this wired up"
// without triggering an import. Before the adapter seam there was no way to
// ask: you found out Gmail was unconfigured by running the nightly job and
// reading a stack trace out of a Google auth client.
//
// Read-only and side-effect free, so it is a GET and needs no API-key path --
// the cron does not call it. Still ADMIN-gated: the reason string names
// integration settings, which is not something to hand to any signed-in user.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getActiveSourceAdapter } from "@/lib/adapters";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      const adapter = await getActiveSourceAdapter();
      const readiness = await adapter.checkReadiness();
      return res.status(200).json({ ...readiness, sourceAdapterId: adapter.id });
    } catch (err: unknown) {
      logError("Source readiness check failed", err);
      return res.status(500).json({ error: getErrorMessage(err, "Readiness check failed") });
    }
  },
);
