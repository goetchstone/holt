// /app/src/pages/api/admin/database/practice.ts
//
// Save a practice copy's starting point, or go back to it (GAP-28). On the same
// permission as the backup and restore routes beside it. Answers only on a practice
// copy; lib/practiceCopyDatabase.ts refuses by the database's name as well.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requirePermission } from "@/lib/auth/requireAuth";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import { auditLog } from "@/lib/audit";
import { logError } from "@/lib/logger";
import { isPracticeCopy } from "@/lib/practiceCopy";
import {
  PracticeCopyError,
  restoreStartingPoint,
  saveStartingPoint,
} from "@/lib/practiceCopyDatabase";

const run = promisify(execFile);

/**
 * The starting point may predate the last upgrade, so it gets what a server does on
 * boot: migrations (docker-entrypoint.sh, the same CLI by the same path) and the
 * built-in roles (instrumentation.ts). Settings are cached, and those just changed.
 */
async function bringUpToDate(): Promise<void> {
  await run("node_modules/.bin/prisma", ["migrate", "deploy"], { timeout: 120_000 });
  await syncBuiltInRoles();
  invalidateAppSettingsCache();
}

export default requirePermission("admin.data", async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const action: unknown = req.body?.action;
  if (action !== "save" && action !== "start-over") {
    return res.status(400).json({ error: 'action must be "save" or "start-over".' });
  }
  if (!isPracticeCopy()) {
    return res
      .status(409)
      .json({ error: "This isn't a practice copy, so this does nothing here." });
  }

  const databaseUrl = process.env.DATABASE_URL as string;
  const actor = session.user?.email || "unknown";
  try {
    if (action === "save") {
      await saveStartingPoint(databaseUrl);
      await auditLog("PRACTICE_STARTING_POINT_SAVED", actor, {
        summary: "This practice copy was saved as the starting point",
      });
    } else {
      await restoreStartingPoint(databaseUrl);
      await bringUpToDate();
      await auditLog("PRACTICE_STARTED_OVER", actor, {
        summary: "This practice copy started over from its starting point",
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof PracticeCopyError) return res.status(409).json({ error: err.message });
    logError("Practice copy operation failed", err, { action });
    return res.status(500).json({
      error:
        action === "save" ? "Couldn't save the starting point." : "Couldn't finish starting over.",
    });
  }
});
