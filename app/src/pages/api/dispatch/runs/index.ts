// /app/src/pages/api/dispatch/runs/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePost(req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

const stopsInclude = {
  stops: {
    orderBy: { stopOrder: "asc" as const },
    include: {
      serviceAppointment: {
        include: {
          salesOrder: {
            select: {
              id: true,
              orderno: true,
              customer: { select: { firstName: true, lastName: true } },
              _count: { select: { lineItems: true } },
            },
          },
          deliveryZone: { select: { name: true } },
        },
      },
    },
  },
};

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: any = {};

  if (req.query.date) {
    const date = new Date(req.query.date as string);
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    where.runDate = { gte: date, lt: nextDay };
  }

  if (req.query.status) {
    where.status = req.query.status;
  }

  if (req.query.vehicleId) {
    where.vehicleId = Number.parseInt(req.query.vehicleId as string);
  }

  const includeStops = req.query.include === "stops";

  try {
    const runs = await prisma.deliveryRun.findMany({
      where,
      include: {
        vehicle: true,
        driver: true,
        ...(includeStops ? stopsInclude : { _count: { select: { stops: true } } }),
      },
      orderBy: { runDate: "desc" },
    });

    return res.status(200).json({ runs });
  } catch (err) {
    logError("Failed to fetch delivery runs", err);
    return res.status(500).json({ error: "Failed to fetch delivery runs" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string | null) {
  const { runDate, vehicleId, driverId } = req.body;

  if (!runDate || !vehicleId) {
    return res.status(400).json({ error: "runDate and vehicleId are required" });
  }

  try {
    const date = new Date(runDate);
    const yy = String(date.getFullYear()).slice(2);
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const datePrefix = `DR-${yy}${mm}${dd}`;

    const existingCount = await prisma.deliveryRun.count({
      where: {
        runNumber: { startsWith: datePrefix },
      },
    });

    const runNumber = `${datePrefix}-${existingCount + 1}`;

    const run = await prisma.deliveryRun.create({
      data: {
        runNumber,
        runDate: date,
        vehicleId: Number.parseInt(vehicleId),
        driverId: driverId ? Number.parseInt(driverId) : undefined,
        createdBy,
      },
      include: {
        vehicle: true,
        driver: true,
      },
    });

    return res.status(201).json(run);
  } catch (err) {
    logError("Failed to create delivery run", err);
    return res.status(500).json({ error: "Failed to create delivery run" });
  }
}
