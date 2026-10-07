// /app/src/lib/billing/billingReadiness.ts
//
// Non-throwing readiness check for the billing GL mappings. issueInvoice()
// already REFUSES to post if "Accounts Receivable" / "Invoice Sales" aren't
// mapped (invoiceService.resolveArGlMappings) — that's the hard guard. This
// module is the soft, observable counterpart: it lets /api/health and the admin
// setup surface report "billing is on but not configured" BEFORE someone tries
// to issue the first invoice and hits the wall. Server-only (queries Prisma).

import { prisma } from "@/lib/prisma";
import { getAppSettings, DEFAULT_ORG_ID } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { logError } from "@/lib/logger";

// The mappings issuance requires, by their (section, label) key.
export const REQUIRED_AR_GL_MAPPINGS: ReadonlyArray<{ section: string; label: string }> = [
  { section: "AR_TRANSACTIONS", label: "Accounts Receivable" },
  { section: "AR_TRANSACTIONS", label: "Invoice Sales" },
];

export interface BillingReadiness {
  // "disabled" — the billing feature is off, so GL config is irrelevant.
  // "ok"       — billing on and every required mapping resolves.
  // "unconfigured" — billing on but one or more required mappings is missing.
  // "error"    — the check itself failed (DB/table absent).
  status: "disabled" | "ok" | "unconfigured" | "error";
  missing: string[];
}

// Pure: given the labels that DID resolve to a GL account, report which
// required ones are still missing. Decoupled from Prisma so the contract is
// unit-tested without a DB.
export function summarizeArGlReadiness(presentLabels: Iterable<string>): {
  ready: boolean;
  missing: string[];
} {
  const present = new Set(presentLabels);
  const missing = REQUIRED_AR_GL_MAPPINGS.filter((m) => !present.has(m.label)).map((m) => m.label);
  return { ready: missing.length === 0, missing };
}

export async function getBillingReadiness(
  orgId: number = DEFAULT_ORG_ID,
): Promise<BillingReadiness> {
  try {
    const settings = await getAppSettings(orgId);
    if (!isFeatureEnabled(settings.features, "billing")) {
      return { status: "disabled", missing: [] };
    }

    const rows = await prisma.systemGLMapping.findMany({
      where: {
        section: "AR_TRANSACTIONS",
        label: { in: REQUIRED_AR_GL_MAPPINGS.map((m) => m.label) },
        glAccountId: { not: null },
      },
      select: { label: true },
    });

    const { ready, missing } = summarizeArGlReadiness(rows.map((r) => r.label));
    return { status: ready ? "ok" : "unconfigured", missing };
  } catch (err) {
    logError("getBillingReadiness failed", err, { orgId });
    return { status: "error", missing: [] };
  }
}
