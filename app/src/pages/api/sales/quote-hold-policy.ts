// /app/src/pages/api/sales/quote-hold-policy.ts
//
// GAP-16: what a screen needs to offer a quote hold -- today on the store's
// clock and the last day a hold set today may run to (AppSettings.
// quoteHoldMaxDays). The server decides every hold again when it is set
// (lib/sales/quoteHolds.ts); this only keeps the screens from offering a day
// it would refuse.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { methodNotAllowed, handleError } from "@/lib/apiResponse";
import { quoteHoldContext } from "@/lib/sales/quoteHolds";
import { latestHoldDate, type QuoteHoldPolicy } from "@/lib/sales/quoteHoldsShared";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    const { today, maxDays } = await quoteHoldContext();
    const policy: QuoteHoldPolicy = { today, maxDays, latest: latestHoldDate(today, maxDays) };
    return res.status(200).json(policy);
  } catch (err) {
    return handleError(res, err, "quote hold policy");
  }
}

export default requirePermission("sales.read", handler);
