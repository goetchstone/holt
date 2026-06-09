// /app/src/pages/api/scheduling/blocks/index.ts
//
// Calendar blocks / time off (admin). GET lists upcoming-first; POST creates a
// block. A block with no staffMemberId is a business-wide closure that removes
// every overlapping slot from the public picker.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseBlockCreateInput } from "@/lib/booking/serviceRequestBody";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") {
      const blocks = await prisma.calendarBlock.findMany({
        where: { organizationId: DEFAULT_ORG_ID },
        orderBy: { startsAt: "desc" },
        include: { staffMember: { select: { id: true, displayName: true } } },
      });
      return res.status(200).json({ blocks });
    }

    if (req.method === "POST") {
      try {
        const input = parseBlockCreateInput(req.body);
        const block = await prisma.calendarBlock.create({
          data: {
            organizationId: DEFAULT_ORG_ID,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            reason: input.reason ?? null,
            staffMemberId: input.staffMemberId ?? null,
            createdBy: session.user?.email ?? null,
          },
        });
        return res.status(201).json({ block });
      } catch (err: unknown) {
        logError("Calendar block create failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not add time off") });
      }
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
