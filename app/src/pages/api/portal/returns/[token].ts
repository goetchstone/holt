// /app/src/pages/api/portal/returns/[token].ts
//
// GET -- the customer's view of their return, for the portal's request and
// status pages. Public: the Return's portalToken is the only credential. The
// answer is PortalReturn (lib/returns/portalReturnContract.ts), the same
// projection the request route answers with.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";
import { PORTAL_RETURN_SELECT, toPortalReturn } from "@/lib/returns/portalReturn";

const limiter = rateLimit({ windowMs: 60_000, maxRequests: 20 }, "portal-return");

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { token } = req.query;

  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Token is required" });
  }

  try {
    const returnRecord = await prisma.return.findUnique({
      where: { portalToken: token },
      select: PORTAL_RETURN_SELECT,
    });

    if (!returnRecord) {
      return res.status(404).json({ error: "Return not found" });
    }

    return res.status(200).json(toPortalReturn(returnRecord));
  } catch (error) {
    logError("Portal return lookup error", error);
    return res.status(500).json({ error: "Failed to retrieve return information" });
  }
});
