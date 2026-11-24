// /app/src/pages/api/portal/returns/request.ts
//
// POST -- the customer submits their return request from the portal page
// (app/portal/return/[token]): a reason, notes, and optionally which line of the
// order it is for. Public: the Return's portalToken, minted by staff with
// POST /api/sales/orders/[id]/return-link, is the only credential.
//
// The body is checked before Prisma sees it (parsePortalReturnRequest): an
// unknown reason is a 400. A named line must be one the return may be for -- on
// the return's own order, counted, and goods (returnLineProblem, the same check
// the staff return-link endpoint makes). The answer is what the portal pages
// read (PortalReturn), never the Return row.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";
import {
  PORTAL_RETURN_SELECT,
  parsePortalReturnRequest,
  toPortalReturn,
} from "@/lib/returns/portalReturn";
import { returnLineProblem } from "@/lib/returns/returnLine";

// 10 requests per minute per IP -- returns submission should be infrequent
const limiter = rateLimit({ windowMs: 60_000, maxRequests: 10 }, "portal-return-request");

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const parsed = parsePortalReturnRequest(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const { portalToken, reason, reasonNotes, lineItemId } = parsed.value;

  try {
    const existing = await prisma.return.findUnique({
      where: { portalToken },
      select: { status: true, portalRequestedAt: true, salesOrderId: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "Invalid or expired return token" });
    }

    if (existing.status !== "INITIATED") {
      return res.status(409).json({ error: "Return is no longer in a submittable state" });
    }

    if (!existing.portalRequestedAt) {
      return res.status(409).json({ error: "Return portal link has not been activated" });
    }

    if (lineItemId !== null) {
      const problem = await returnLineProblem(prisma, existing.salesOrderId, lineItemId);
      if (problem) return res.status(400).json({ error: problem });
    }

    const updated = await prisma.return.update({
      where: { portalToken },
      data: {
        reason,
        customerNotes: reasonNotes,
        ...(lineItemId !== null ? { lineItemId } : {}),
      },
      select: PORTAL_RETURN_SELECT,
    });

    return res.status(200).json(toPortalReturn(updated));
  } catch (error) {
    logError("Portal return request error", error);
    return res.status(500).json({ error: "Failed to submit return request" });
  }
});
