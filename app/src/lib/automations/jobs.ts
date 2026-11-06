// /app/src/lib/automations/jobs.ts
//
// What each automation in lib/automations/catalog.ts actually runs, and whether it can
// run yet. Compile-time, so a stored setting can only choose among these (rule 62). Each
// says in one line what it did, for Admin > Automations.

import { prisma } from "@/lib/prisma";
import { getActiveSourceAdapter } from "@/lib/adapters";
import { runCustomerArDriftCheck } from "@/lib/customerArDriftRunner";
import { runDailyReconciliation } from "@/lib/dailyReconciliationRun";
import { runEmailQueueCycle } from "@/lib/email/queueCycle";
import { resolveCredential } from "@/lib/integrationCredentials";
import { runCustomerAudienceSync } from "@/lib/mailchimpAudienceSync";
import { runMailchimpSync } from "@/lib/mailchimpSyncRun";
import { sweepStalePendingPayments } from "@/lib/paymentService";
import { releaseExpiredHolds } from "@/lib/sales/quoteHolds";
import { runAndStampTrafficLog, startTrafficSyncLog } from "@/lib/trafficSyncRun";
import type { AutomationKey } from "./catalog";
import { runCustomerLevelRecalc, runLeadHousekeeping } from "./loggedRuns";

const ACTOR = "automations";
/** The route's own default: a month of days to check for gaps. */
const TRAFFIC_BACKFILL_DAYS = 30;

export interface JobOutcome {
  ok: boolean;
  summary: string;
}

export interface AutomationJob {
  /** Why it can't run yet, in words a store can act on; null when it can. */
  notReady?: () => Promise<string | null>;
  run: () => Promise<JobOutcome>;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

async function mailchimpNotReady(): Promise<string | null> {
  const key = await resolveCredential("mailchimp", "apiKey", "MAILCHIMP_API_KEY");
  return key ? null : "Mailchimp isn't set up yet. Add its API key in Settings › Integrations.";
}

export const AUTOMATION_JOBS: Record<AutomationKey, AutomationJob> = {
  "send-queue": {
    run: async () => {
      const { summary, texts } = await runEmailQueueCycle();
      const waiting = summary.skipped > 0 ? ", the rest waiting for email to be set up" : "";
      return {
        ok: true,
        summary: `${count(summary.sent, "email")} sent, ${summary.failed} failed${waiting}. ${count(texts.sent, "text")} sent.`,
      };
    },
  },
  "quote-holds": {
    run: async () => {
      const result = await releaseExpiredHolds(prisma);
      return { ok: true, summary: `${count(result.released, "quote")} released stock.` };
    },
  },
  "stale-payments": {
    run: async () => {
      const result = await sweepStalePendingPayments();
      return { ok: true, summary: `${count(result.swept, "payment")} closed.` };
    },
  },
  reconciliation: {
    run: async () => {
      const result = await runDailyReconciliation({ createdBy: ACTOR });
      return {
        ok: result.daysWithError === 0,
        summary: `${count(result.daysBalanced, "day")} balanced, ${result.daysWithDrift} with drift, ${result.daysWithError} failed.`,
      };
    },
  },
  "ar-drift": {
    run: async () => {
      const result = await runCustomerArDriftCheck();
      return {
        ok: true,
        summary: `${count(result.checked, "customer")} checked, ${result.drifted.length} off.`,
      };
    },
  },
  "customer-levels": {
    run: async () => {
      const result = await runCustomerLevelRecalc();
      return {
        ok: result.status !== "FAILED",
        summary: result.errors[0] ?? `${count(result.customersUpdated, "customer")} updated.`,
      };
    },
  },
  "lead-housekeeping": {
    run: async () => {
      const result = await runLeadHousekeeping();
      return {
        ok: result.status !== "FAILED",
        summary: result.errors[0] ?? `${count(result.leadsArchived, "lead")} archived.`,
      };
    },
  },
  "source-import": {
    notReady: async () => {
      const readiness = await (await getActiveSourceAdapter()).checkReadiness();
      return readiness.ready ? null : (readiness.reason ?? "The import isn't set up yet.");
    },
    run: async () => {
      const adapter = await getActiveSourceAdapter();
      const result = await adapter.runImport({ dryRun: false, createdBy: ACTOR });
      return {
        ok: result.errors.length === 0,
        summary:
          result.errors[0] ??
          result.message ??
          `${count(result.imports.length, "report")} imported, ${result.emailsSkipped} skipped.`,
      };
    },
  },
  traffic: {
    notReady: async () => {
      const key = await resolveCredential("axper", "apiKey", "AXPER_API_KEY");
      return key ? null : "The door counter isn't set up yet. Add it in Settings › Integrations.";
    },
    run: async () => {
      const log = await startTrafficSyncLog(ACTOR);
      await runAndStampTrafficLog(log.id, TRAFFIC_BACKFILL_DAYS);
      const done = await prisma.trafficSyncLog.findUniqueOrThrow({ where: { id: log.id } });
      return {
        ok: done.errors.length === 0,
        summary: done.errors[0] ?? `${count(done.daysScanned ?? 0, "day")} checked.`,
      };
    },
  },
  "mailchimp-sync": {
    notReady: mailchimpNotReady,
    run: async () => {
      const result = await runMailchimpSync("all");
      return {
        ok: result.status !== "FAILED",
        summary:
          result.errors[0] ??
          `${count(result.campaignsUpserted, "campaign")}, ${count(result.leadsCreated, "new lead")}.`,
      };
    },
  },
  "mailchimp-customers": {
    notReady: mailchimpNotReady,
    run: async () => {
      const result = await runCustomerAudienceSync();
      return {
        ok: result.errors.length === 0,
        summary: `${count(result.pushed, "customer")} added, ${result.errors.length} failed.`,
      };
    },
  },
};
