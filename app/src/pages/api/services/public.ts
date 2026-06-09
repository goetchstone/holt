// /app/src/pages/api/services/public.ts
//
// Public list of bookable services (isPublic + isActive) for the /book page.
// No auth; minimal fields only. Rate-limited like the other public read paths.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

const limiter = rateLimit({ windowMs: 60_000, maxRequests: 60 });

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
  try {
    const services = await prisma.service.findMany({
      where: { organizationId: DEFAULT_ORG_ID, isPublic: true, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        durationMinutes: true,
        price: true,
      },
    });
    return res.status(200).json({
      services: services.map((s) => ({ ...s, price: s.price == null ? null : Number(s.price) })),
    });
  } catch (err: unknown) {
    logError("Public services list failed", err);
    return res.status(500).json({ error: getErrorMessage(err, "Could not load services") });
  }
});
