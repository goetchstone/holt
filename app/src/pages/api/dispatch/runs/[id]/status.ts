// /app/src/pages/api/dispatch/runs/[id]/status.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { DeliveryRunStatus } from "@prisma/client";
import { logError } from "@/lib/logger";

const VALID_TRANSITIONS: Record<DeliveryRunStatus, DeliveryRunStatus[]> = {
  PLANNING: ["LOADED"],
  LOADED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid run ID" });

  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });

  try {
    const run = await prisma.deliveryRun.findUnique({ where: { id } });
    if (!run) return res.status(404).json({ error: "Delivery run not found" });

    const allowed = VALID_TRANSITIONS[run.status];
    if (!allowed || !allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from ${run.status} to ${status}`,
      });
    }

    const data: any = {
      status,
      updatedBy: session.user?.email || null,
    };

    if (status === "IN_PROGRESS") {
      data.departedAt = new Date();
    } else if (status === "COMPLETED") {
      data.completedAt = new Date();
    }

    const updated = await prisma.deliveryRun.update({
      where: { id },
      data,
      include: { vehicle: true, driver: true },
    });

    return res.status(200).json(updated);
  } catch (error) {
    logError("Error updating run status", error);
    return res.status(500).json({ error: "Failed to update run status" });
  }
}
