// /app/src/pages/api/scheduling/windows/index.ts
//
// Availability windows (admin) -- weekly recurring business hours that drive the
// service slot picker. GET lists them; POST creates one. MVP windows are
// org-wide (staffMemberId null); an optional serviceId scopes a window to one
// service.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseWindowCreateInput } from "@/lib/booking/serviceRequestBody";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") {
      const windows = await prisma.availabilityWindow.findMany({
        where: { organizationId: DEFAULT_ORG_ID },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
        include: { service: { select: { id: true, name: true } } },
      });
      return res.status(200).json({ windows });
    }

    if (req.method === "POST") {
      try {
        const input = parseWindowCreateInput(req.body);
        const window = await prisma.availabilityWindow.create({
          data: {
            organizationId: DEFAULT_ORG_ID,
            dayOfWeek: input.dayOfWeek,
            startTime: input.startTime,
            endTime: input.endTime,
            serviceId: input.serviceId ?? null,
            createdBy: session.user?.email ?? null,
          },
        });
        return res.status(201).json({ window });
      } catch (err: unknown) {
        logError("Availability window create failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not add window") });
      }
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
