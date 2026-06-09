// /app/src/pages/api/dispatch/vehicles/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid vehicle ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "PUT") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id },
      include: {
        _count: { select: { deliveryRuns: true } },
      },
    });

    if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

    return res.status(200).json(vehicle);
  } catch (error) {
    logError("Error fetching vehicle", error);
    return res.status(500).json({ error: "Failed to fetch vehicle" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  updatedBy: string | null,
) {
  const { name, type, licensePlate, capacity, notes, isActive } = req.body;

  try {
    const vehicle = await prisma.vehicle.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        type: type !== undefined ? type : undefined,
        licensePlate: licensePlate !== undefined ? licensePlate : undefined,
        capacity: capacity !== undefined ? Number.parseInt(capacity) : undefined,
        notes: notes !== undefined ? notes : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
        updatedBy,
      },
    });

    return res.status(200).json(vehicle);
  } catch (error) {
    logError("Error updating vehicle", error);
    return res.status(500).json({ error: "Failed to update vehicle" });
  }
}
