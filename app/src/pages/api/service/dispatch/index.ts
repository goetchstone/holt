// /app/src/pages/api/service/dispatch/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import type { ServiceAppointmentStatus } from "@prisma/client";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const page = Number.parseInt(req.query.page as string) || 1;
  const limit = Number.parseInt(req.query.limit as string) || 20;
  const tab = (req.query.tab as string) || "pending";
  const type = req.query.type as string | undefined;
  const storeLocationId = req.query.storeLocationId as string | undefined;

  const where: any = {
    type: { in: ["MEASURE", "INSTALL", "DELIVERY"] },
  };

  const pendingStatuses: ServiceAppointmentStatus[] = ["PENDING"];
  const scheduledStatuses: ServiceAppointmentStatus[] = ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"];
  const completedStatuses: ServiceAppointmentStatus[] = ["COMPLETED", "CANCELLED"];

  if (tab === "pending") {
    where.status = { in: pendingStatuses };
  } else if (tab === "scheduled") {
    where.status = { in: scheduledStatuses };
  } else if (tab === "completed") {
    where.status = { in: completedStatuses };
  }

  if (type) {
    where.type = type;
  }

  if (storeLocationId) {
    where.storeLocationId = Number.parseInt(storeLocationId);
  }

  let orderBy: any;
  if (tab === "pending") {
    orderBy = { created: "desc" as const };
  } else if (tab === "scheduled") {
    orderBy = { scheduledDate: "asc" as const };
  } else {
    orderBy = { completedAt: "desc" as const };
  }

  try {
    const [appointments, total] = await Promise.all([
      prisma.serviceAppointment.findMany({
        where,
        include: {
          salesOrder: { select: { orderno: true } },
          customer: { select: { firstName: true, lastName: true } },
          address: { select: { address1: true, city: true, state: true, zip: true } },
          installer: { select: { name: true } },
          storeLocation: { select: { name: true } },
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.serviceAppointment.count({ where }),
    ]);

    return res.status(200).json({ appointments, total });
  } catch (error) {
    logError("Error fetching dispatch appointments", error);
    return res.status(500).json({ error: "Failed to fetch appointments" });
  }
}
