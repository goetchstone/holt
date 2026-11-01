// /app/src/pages/api/automations/expire-quote-holds.ts
//
// Puts back on sale the stock of quotes whose holds have run out (GAP-16). A
// quote holds a floor-stock line for its customer through a chosen day
// (lib/sales/quoteHolds.ts); after it, nothing should keep that piece off the
// floor. A quote's own edits already resync it, but a quote nobody touches has
// no write to do that on, so this sweep is what lets its stock go.
//
// It also releases what quotes written before holds existed still commit:
// every quote used to commit every line, with no end date.
//
// Scheduled by scripts/auto-expire-quote-holds.sh. Dual auth via
// guardAutomation: the scheduler's Bearer service key (AUTO_IMPORT_API_KEY),
// or a session holding `admin.automations`.

import type { NextApiRequest, NextApiResponse } from "next";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { prisma } from "@/lib/prisma";
import { releaseExpiredHolds } from "@/lib/sales/quoteHolds";
import { logError, logger } from "@/lib/logger";

/** Exported for integration tests, which call it without the gate. */
export async function run(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const result = await releaseExpiredHolds(prisma);
    logger.info("expire-quote-holds: swept", { ...result });
    return res.status(200).json(result);
  } catch (err) {
    logError("expire-quote-holds failed", err);
    return res.status(500).json({ error: "Failed to release expired quote holds" });
  }
}

export default guardAutomation(run);
