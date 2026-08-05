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
// Dual auth model: Bearer (AUTO_IMPORT_API_KEY) for unattended cron runs,
// NextAuth session for manual triggering — same isAuthorized() shape as
// daily-reconciliation.ts. No role gating beyond authentication: marking a
// stale row FAILED is strictly less destructive than the MANAGER/ADMIN-
// gated manual void endpoint (payments/[paymentId]/void.ts), since FAILED
// only ever applies to rows that are already, factually, abandoned.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { sweepStalePendingPayments } from "@/lib/paymentService";
import { logError, logger } from "@/lib/logger";

function isAuthorized(
  req: NextApiRequest,
  session: { user?: { email?: string | null } } | null,
): boolean {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey && req.headers.authorization === `Bearer ${apiKey}`) return true;
  if (session?.user?.email) return true;
  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!isAuthorized(req, session)) {
    return res.status(401).json({ error: "Unauthorized" });
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
