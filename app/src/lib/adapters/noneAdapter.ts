// /app/src/lib/adapters/noneAdapter.ts
//
// "This deployment has no source system."
//
// This is the SHIPPED DEFAULT, and it is the whole point of the adapter seam.
// Before it, a fresh install's only answer to "where does data come from" was
// the Ordorite adapter -- so a deployment that had never heard of Ordorite
// still got its import route, its admin page, and its failure modes, and the
// honest state "we key everything natively" was indistinguishable from
// "Ordorite, misconfigured."
//
// Running it is a no-op that says so, rather than an error. A cron pointed at
// a deployment that imports nothing should report nothing to do -- not fail
// nightly and page whoever owns the alert.

import { randomUUID } from "node:crypto";
import type { ImportRunSummary, SourceAdapter, SourceAdapterReadiness } from "@/lib/adapters/types";

export const noneAdapter: SourceAdapter = {
  id: "none",
  label: "No source system",
  description:
    "Everything is entered in holt. Nothing is pulled from another system. Scheduled imports do nothing.",
  moduleFlag: null,

  async checkReadiness(): Promise<SourceAdapterReadiness> {
    return { ready: true };
  },

  async runImport(opts: { dryRun: boolean; createdBy: string }): Promise<ImportRunSummary> {
    return {
      runId: randomUUID(),
      dryRun: opts.dryRun,
      emailsProcessed: 0,
      emailsSkipped: 0,
      imports: [],
      errors: [],
      message:
        "No source system is configured for this deployment, so there was nothing to import. " +
        "Choose one in Settings if that is wrong.",
    };
  },
};
