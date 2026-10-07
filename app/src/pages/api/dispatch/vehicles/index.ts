// /app/src/pages/api/dispatch/vehicles/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    return handlePost(req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: any = {};
  if (req.query.isActive === "true") {
    where.isActive = true;
  } else if (req.query.isActive === "false") {
    where.isActive = false;
  }

  try {
    const vehicles = await prisma.vehicle.findMany({
      where,
      orderBy: { name: "asc" },
    });

    return res.status(200).json({ vehicles });
  } catch (error) {
    logError("Error fetching vehicles", error);
    return res.status(500).json({ error: "Failed to fetch vehicles" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string | null) {
  const { name, type, licensePlate, capacity, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const vehicle = await prisma.vehicle.create({
      data: {
        name,
        type: type || undefined,
        licensePlate: licensePlate || undefined,
        capacity: capacity !== undefined ? Number.parseInt(capacity) : undefined,
        notes: notes || undefined,
        createdBy,
      },
    });

    return res.status(201).json(vehicle);
  } catch (error) {
    logError("Error creating vehicle", error);
    return res.status(500).json({ error: "Failed to create vehicle" });
  }
}

export default requirePermission("warehouse.operate", handler);
