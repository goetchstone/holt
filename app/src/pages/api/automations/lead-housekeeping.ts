// /app/src/pages/api/automations/lead-housekeeping.ts
//
// Nightly lead-aging job. Auto-archives leads that have been silent for
// 30 days (ARCHIVE_AFTER_DAYS). Exempts pinned leads and leads whose
// customer has an active QUOTE. Safe to run repeatedly — idempotent.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import { logError, logger } from "@/lib/logger";
import { autoArchiveStaleLeads } from "@/lib/leadHousekeeping";

async function run(req: NextApiRequest, res: NextApiResponse, session: Session | null) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const runId = randomUUID();
  const startedAt = new Date();
  const errors: string[] = [];
  let leadsArchived = 0;

  try {
    const result = await autoArchiveStaleLeads(startedAt);
    leadsArchived = result.leadsArchived;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`auto-archive: ${msg}`);
    logError("lead-housekeeping auto-archive failed", err);
  }

  const finishedAt = new Date();
  const status = errors.length === 0 ? "SUCCESS" : "FAILED";

  const log = await prisma.mailchimpSyncLog.create({
    data: {
      runId,
      kind: "lead-housekeeping",
      status,
      leadsArchived,
      errors,
      startedAt,
      finishedAt,
    },
  });

  logger.info("lead-housekeeping complete", {
    runId,
    status,
    leadsArchived,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });

  return res.status(status === "FAILED" ? 500 : 200).json({
    runId,
    status,
    leadsArchived,
    errors,
    logId: log.id,
  });
}

export default guardAutomation(run);
