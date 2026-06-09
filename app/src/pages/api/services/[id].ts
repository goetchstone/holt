// /app/src/pages/api/services/[id].ts
//
// Single service (admin): PATCH any subset of fields (slug follows a rename),
// DELETE removes it (bookings keep their history via SetNull; windows cascade).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseServiceUpdateInput } from "@/lib/booking/serviceRequestBody";
import { slugify } from "@/lib/booking/scheduling";
import { getErrorMessage } from "@/lib/toastError";
import { getErrorCode } from "@/lib/errorCode";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.service.findFirst({
      where: { id, organizationId: DEFAULT_ORG_ID },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: "Service not found" });

    if (req.method === "PATCH") {
      try {
        const input = parseServiceUpdateInput(req.body);
        const data: Prisma.ServiceUpdateInput = { updatedBy: session.user?.email ?? null };
        if (input.name !== undefined) {
          data.name = input.name;
          data.slug = slugify(input.name) || `service-${id}`;
        }
        if (input.description !== undefined) data.description = input.description ?? null;
        if (input.durationMinutes !== undefined) data.durationMinutes = input.durationMinutes;
        if (input.bufferMinutes !== undefined) data.bufferMinutes = input.bufferMinutes;
        if (input.price !== undefined) data.price = input.price ?? null;
        if (input.isPublic !== undefined) data.isPublic = input.isPublic;
        if (input.isActive !== undefined) data.isActive = input.isActive;
        if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

        const service = await prisma.service.update({ where: { id }, data });
        return res.status(200).json({
          service: { ...service, price: service.price == null ? null : Number(service.price) },
        });
      } catch (err: unknown) {
        if (getErrorCode(err) === "P2002") {
          return res.status(409).json({ error: "A service with that name already exists" });
        }
        logError("Service update failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not update service") });
      }
    }

    if (req.method === "DELETE") {
      await prisma.service.delete({ where: { id } });
      return res.status(204).end();
    }

    res.setHeader("Allow", ["PATCH", "DELETE"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
