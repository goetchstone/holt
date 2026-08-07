// /app/src/pages/api/dispatch/runs/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid run ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "PUT") {
    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const run = await prisma.deliveryRun.findUnique({
      where: { id },
      include: {
        vehicle: true,
        driver: true,
        stops: {
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
        },
      },
    });

    if (!run) return res.status(404).json({ error: "Delivery run not found" });

    return res.status(200).json(run);
  } catch (error) {
    logError("Error fetching delivery run", error);
    return res.status(500).json({ error: "Failed to fetch delivery run" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  updatedBy: string | null,
) {
  const { driverId, notes, runDate } = req.body;

  try {
    const run = await prisma.deliveryRun.update({
      where: { id },
      data: {
        driverId:
          driverId !== undefined ? (driverId ? Number.parseInt(driverId) : null) : undefined,
        notes: notes !== undefined ? notes : undefined,
        runDate: runDate !== undefined ? new Date(runDate) : undefined,
        updatedBy,
      },
      include: {
        vehicle: true,
        driver: true,
      },
    });

    return res.status(200).json(run);
  } catch (error) {
    logError("Error updating delivery run", error);
    return res.status(500).json({ error: "Failed to update delivery run" });
  }
}

export default requirePermission("warehouse.operate", handler);
