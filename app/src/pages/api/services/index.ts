// /app/src/pages/api/services/index.ts
//
// Service catalog (admin). GET lists every service for the org; POST creates one
// with a slug derived from the name. Drives the public booking flow.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseServiceCreateInput } from "@/lib/booking/serviceRequestBody";
import { slugify } from "@/lib/booking/scheduling";
import { getErrorMessage } from "@/lib/toastError";
import { getErrorCode } from "@/lib/errorCode";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") {
      const services = await prisma.service.findMany({
        where: { organizationId: DEFAULT_ORG_ID },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      return res.status(200).json({
        services: services.map((s) => ({ ...s, price: s.price == null ? null : Number(s.price) })),
      });
    }

    if (req.method === "POST") {
      try {
        const input = parseServiceCreateInput(req.body);
        const email = session.user?.email ?? null;
        const service = await prisma.service.create({
          data: {
            organizationId: DEFAULT_ORG_ID,
            name: input.name,
            slug: slugify(input.name) || `service-${Date.now()}`,
            description: input.description ?? null,
            durationMinutes: input.durationMinutes,
            bufferMinutes: input.bufferMinutes ?? 0,
            price: input.price ?? null,
            isPublic: input.isPublic ?? true,
            isActive: input.isActive ?? true,
            sortOrder: input.sortOrder ?? 0,
            createdBy: email,
            updatedBy: email,
          },
        });
        return res.status(201).json({ service });
      } catch (err: unknown) {
        if (getErrorCode(err) === "P2002") {
          return res.status(409).json({ error: "A service with that name already exists" });
        }
        logError("Service create failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not create service") });
      }
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
