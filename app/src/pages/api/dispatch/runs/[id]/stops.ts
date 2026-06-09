// /app/src/pages/api/dispatch/runs/[id]/stops.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const runId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(runId)) return res.status(400).json({ error: "Invalid run ID" });

  if (req.method === "GET") {
    return handleGet(runId, res);
  } else if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePost(runId, req, res);
  } else if (req.method === "PUT") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handleReorder(runId, req, res);
  } else if (req.method === "DELETE") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handleDelete(runId, req, res);
  }

  res.setHeader("Allow", ["GET", "POST", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(runId: number, res: NextApiResponse) {
  try {
    const stops = await prisma.deliveryStop.findMany({
      where: { deliveryRunId: runId },
      orderBy: { stopOrder: "asc" },
      include: {
        serviceAppointment: {
          include: {
            customer: true,
            address: true,
            salesOrder: {
              include: { lineItems: true },
            },
          },
        },
      },
    });

    return res.status(200).json({ stops });
  } catch (error) {
    logError("Error fetching stops", error);
    return res.status(500).json({ error: "Failed to fetch stops" });
  }
}

async function handlePost(runId: number, req: NextApiRequest, res: NextApiResponse) {
  const { serviceAppointmentId } = req.body;

  if (!serviceAppointmentId) {
    return res.status(400).json({ error: "serviceAppointmentId is required" });
  }

  try {
    const maxStop = await prisma.deliveryStop.findFirst({
      where: { deliveryRunId: runId },
      orderBy: { stopOrder: "desc" },
      select: { stopOrder: true },
    });

    const stopOrder = (maxStop?.stopOrder ?? 0) + 1;

    const stop = await prisma.deliveryStop.create({
      data: {
        deliveryRunId: runId,
        serviceAppointmentId: Number.parseInt(serviceAppointmentId),
        stopOrder,
      },
      include: {
        serviceAppointment: {
          include: {
            customer: true,
            address: true,
          },
        },
      },
    });

    return res.status(201).json(stop);
  } catch (error) {
    logError("Error adding stop", error);
    return res.status(500).json({ error: "Failed to add stop" });
  }
}

async function handleReorder(runId: number, req: NextApiRequest, res: NextApiResponse) {
  const { stopIds } = req.body;

  if (!Array.isArray(stopIds) || stopIds.length === 0) {
    return res.status(400).json({ error: "stopIds array is required" });
  }

  try {
    await prisma.$transaction(
      stopIds.map((stopId: number, index: number) =>
        prisma.deliveryStop.update({
          where: { id: stopId },
          data: { stopOrder: index + 1 },
        }),
      ),
    );

    const stops = await prisma.deliveryStop.findMany({
      where: { deliveryRunId: runId },
      orderBy: { stopOrder: "asc" },
    });

    return res.status(200).json({ stops });
  } catch (error) {
    logError("Error reordering stops", error);
    return res.status(500).json({ error: "Failed to reorder stops" });
  }
}

async function handleDelete(runId: number, req: NextApiRequest, res: NextApiResponse) {
  const stopId = Number.parseInt(req.query.stopId as string);
  if (Number.isNaN(stopId)) {
    return res.status(400).json({ error: "stopId query param is required" });
  }

  try {
    const stop = await prisma.deliveryStop.findFirst({
      where: { id: stopId, deliveryRunId: runId },
    });

    if (!stop) {
      return res.status(404).json({ error: "Stop not found on this run" });
    }

    await prisma.deliveryStop.delete({ where: { id: stopId } });

    return res.status(200).json({ success: true });
  } catch (error) {
    logError("Error deleting stop", error);
    return res.status(500).json({ error: "Failed to delete stop" });
  }
}
