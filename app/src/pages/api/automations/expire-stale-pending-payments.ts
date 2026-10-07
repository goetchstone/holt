// /app/src/pages/api/automations/expire-stale-pending-payments.ts
//
// Sweeper for abandoned hosted-checkout PENDING payments the webhook never
// resolved. The webhook's checkout.session.expired handling
// (pages/api/stripe/webhook.ts) is the primary mechanism, but webhooks get
// missed, and Square's Payment Links API has no expiry event at all to miss
// in the first place (see lib/payments/squareProvider.ts). Without this
// backstop, a PENDING row from an abandoned or declined checkout just sits
// there forever — computeBalance already stopped crediting it the moment
// PENDING was excluded from the balance, but the row itself never reaches a
// terminal status, so it keeps reading as "in progress" indefinitely and
// nobody can tell an abandoned checkout from one still genuinely open
// without checking the timestamp by hand.
//
// Wraps `sweepStalePendingPayments` from lib/paymentService.ts, which marks
// every PENDING row older than PENDING_SESSION_LIFETIME_MS (24h — Stripe's
// own checkout-session lifetime) FAILED. No ledger entry is touched:
// recordPendingPayment never posts one for a PENDING row, so there's
// nothing to reverse.
//
// Dual auth model via guardAutomation: the scheduler presents the Bearer
// service key (AUTO_IMPORT_API_KEY); a human trigger requires the
// `admin.automations` permission. This used to accept any authenticated
// session, which -- after the OAuth gate landed in SEC-01 -- was still any
// staff account; firing a scheduled job is a system-administration action.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { sweepStalePendingPayments } from "@/lib/paymentService";
import { logError, logger } from "@/lib/logger";

async function run(req: NextApiRequest, res: NextApiResponse, session: Session | null) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const result = await sweepStalePendingPayments();
    if (result.swept > 0) {
      logger.warn("expire-stale-pending-payments: swept stale PENDING rows", {
        swept: result.swept,
        totalAmount: result.totalAmount,
      });
    } else {
      logger.info("expire-stale-pending-payments: nothing stale");
    }
    return res.status(200).json(result);
  } catch (err) {
    logError("expire-stale-pending-payments failed", err);
    return res.status(500).json({ error: "Failed to sweep stale pending payments" });
  }
}

export default guardAutomation(run);
