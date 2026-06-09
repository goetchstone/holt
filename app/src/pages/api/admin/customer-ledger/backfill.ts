// /app/src/pages/api/admin/customer-ledger/backfill.ts
//
// Phase 0.5.3 — admin endpoint to trigger the customer-ledger backfill.
// One-time job (per the SOR plan); subsequent runs are no-ops thanks to
// the per-customer idempotency check in `backfillCustomerLedger`.
//
// ADMIN-only. Returns a summary of the run including drift counts so
// the operator can decide whether to investigate.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { backfillAllCustomers } from "@/lib/customerLedgerBackfill";
import { logger, logError } from "@/lib/logger";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  // Optional `customerIds` body param to backfill a subset (useful for
  // smoke-testing on a few customers before the full run).
  const customerIds = Array.isArray(req.body?.customerIds)
    ? req.body.customerIds.filter((n: unknown): n is number => Number.isInteger(n))
    : undefined;

  logger.info("customer-ledger backfill starting", {
    scope: customerIds ? `${customerIds.length} customers` : "all customers",
  });

  try {
    const result = await backfillAllCustomers({
      customerIds,
      onProgress: (done, total) => {
        if (done % 100 === 0 || done === total) {
          logger.info(`customer-ledger backfill progress: ${done}/${total}`);
        }
      },
    });

    logger.info("customer-ledger backfill complete", {
      total: result.customersTotal,
      backfilled: result.customersBackfilled,
      backfilledWithDrift: result.customersBackfilledWithDrift,
      skipped: result.customersSkipped,
      failed: result.customersFailed,
      entriesCreated: result.entriesCreated,
      totalDriftDollars: result.totalDriftDollars,
    });

    return res.status(200).json(result);
  } catch (err) {
    logError("customer-ledger backfill threw", err);
    return res.status(500).json({ error: "Backfill run failed at the orchestrator level" });
  }
});
