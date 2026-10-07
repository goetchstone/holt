// /app/src/lib/adapters/ordorite/adapter.ts
//
// The Ordorite source adapter: the SourceAdapter face of everything else in
// this folder. Deliberately thin -- it wires the existing orchestrator to the
// seam and adds the one thing the orchestrator never had, a readiness check
// that does not require attempting an import to discover that Gmail was never
// configured.
//
// Ordorite delivers by emailing CSV reports to a mailbox holt polls. That is a
// fact about Ordorite, which is why it lives here and not in the route.

import type { ImportRunSummary, SourceAdapter, SourceAdapterReadiness } from "@/lib/adapters/types";
import { resolveCredential } from "@/lib/integrationCredentials";
import { runGmailImport } from "./orchestrator";

export const ORDORITE_ADAPTER_ID = "ordorite";

export const ordoriteAdapter: SourceAdapter = {
  id: ORDORITE_ADAPTER_ID,
  label: "Ordorite",
  description:
    "Polls a Gmail mailbox for the CSV reports Ordorite emails on a schedule, routes each attachment by filename, and imports it.",
  moduleFlag: "legacyPosImport",

  // Mirrors exactly what gmailClient.buildGmailService() demands, so "ready"
  // here means the next run gets past auth. Both lookups are DB-first with an
  // env fallback -- checking only the env vars would report a correctly
  // configured deployment as broken.
  async checkReadiness(): Promise<SourceAdapterReadiness> {
    try {
      const serviceAccount = await resolveCredential(
        "gmail",
        "serviceAccountJson",
        "GMAIL_SERVICE_ACCOUNT_PATH",
      );
      if (!serviceAccount) {
        return {
          ready: false,
          reason:
            "Gmail service account is not configured. Paste the service-account JSON in Settings -> Integrations -> Gmail, or set GMAIL_SERVICE_ACCOUNT_PATH.",
        };
      }
      const delegate =
        (await resolveCredential("gmail", "delegateEmail", "GMAIL_DELEGATE_EMAIL")) ||
        process.env.GMAIL_IMPERSONATE_EMAIL;
      if (!delegate) {
        return {
          ready: false,
          reason:
            "Gmail delegate email is not configured. Set it in Settings -> Integrations -> Gmail, or via GMAIL_DELEGATE_EMAIL.",
        };
      }
      return { ready: true };
    } catch (err) {
      // Contract: checkReadiness never throws. A credential store that is
      // itself broken (missing APP_ENCRYPTION_KEY, unreachable DB) is a
      // not-ready reason, not an exception for the caller to handle twice.
      return {
        ready: false,
        reason: `Could not read Gmail credentials: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  },

  async runImport(opts: { dryRun: boolean; createdBy: string }): Promise<ImportRunSummary> {
    return runGmailImport(opts);
  },
};
