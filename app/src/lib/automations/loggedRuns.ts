// /app/src/lib/automations/loggedRuns.ts
//
// The two jobs that are one call plus a row in MailchimpSyncLog (kind = their name), so
// their history shows with the others. Moved out of their routes so Admin > Automations
// and the routes run the same thing (GAP-37, rule 14).

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";
import { recalculateCustomerLevels } from "@/lib/customerLeveling";
import { autoArchiveStaleLeads } from "@/lib/leadHousekeeping";

export async function runCustomerLevelRecalc() {
  const runId = randomUUID();
  const startedAt = new Date();
  const errors: string[] = [];
  let customersUpdated = 0;

  try {
    const result = await recalculateCustomerLevels();
    customersUpdated = result.customersUpdated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`recalculate: ${msg}`);
    logError("customer-level-recalc failed", err);
  }

  const finishedAt = new Date();
  const status = errors.length === 0 ? "SUCCESS" : "FAILED";

  const log = await prisma.mailchimpSyncLog.create({
    data: {
      runId,
      kind: "customer-level-recalc",
      status,
      errors,
      startedAt,
      finishedAt,
    },
  });

  logger.info("customer-level-recalc complete", {
    runId,
    status,
    customersUpdated,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });

  return { runId, status, customersUpdated, errors, logId: log.id };
}

export async function runLeadHousekeeping() {
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

  return { runId, status, leadsArchived, errors, logId: log.id };
}
