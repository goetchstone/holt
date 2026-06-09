// /app/src/pages/api/service/delivery-zones/[id]/zips.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid zone ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["MANAGER", "ADMIN"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePost(id, req, res);
  } else if (req.method === "DELETE") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["MANAGER", "ADMIN"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handleDelete(id, req, res);
  }

  res.setHeader("Allow", ["GET", "POST", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(zoneId: number, res: NextApiResponse) {
  try {
    const zips = await prisma.deliveryZoneZip.findMany({
      where: { deliveryZoneId: zoneId },
      orderBy: { zipCode: "asc" },
    });

    return res.status(200).json(zips);
  } catch (error) {
    logError("Error fetching zone zips", error);
    return res.status(500).json({ error: "Failed to fetch zone zip codes" });
  }
}

async function handlePost(zoneId: number, req: NextApiRequest, res: NextApiResponse) {
  const { zipCodes } = req.body;

  if (!Array.isArray(zipCodes) || zipCodes.length === 0) {
    return res.status(400).json({ error: "zipCodes array is required" });
  }

  const zipPattern = /^\d{5}$/;
  const invalid: string[] = [];
  const valid: string[] = [];

  for (const zip of zipCodes) {
    if (zipPattern.test(zip)) {
      valid.push(zip);
    } else {
      invalid.push(zip);
    }
  }

  try {
    let added = 0;
    let reassigned = 0;

    await prisma.$transaction(async (tx) => {
      for (const zipCode of valid) {
        const existing = await tx.deliveryZoneZip.findFirst({
          where: { zipCode },
        });

        if (existing) {
          if (existing.deliveryZoneId === zoneId) {
            // Already in this zone, skip
            continue;
          }
          // Reassign from another zone
          await tx.deliveryZoneZip.delete({ where: { id: existing.id } });
          await tx.deliveryZoneZip.create({
            data: { deliveryZoneId: zoneId, zipCode },
          });
          reassigned++;
        } else {
          await tx.deliveryZoneZip.create({
            data: { deliveryZoneId: zoneId, zipCode },
          });
          added++;
        }
      }
    });

    return res.status(200).json({ added, reassigned, invalid });
  } catch (error) {
    logError("Error adding zone zips", error);
    return res.status(500).json({ error: "Failed to add zip codes" });
  }
}

async function handleDelete(zoneId: number, req: NextApiRequest, res: NextApiResponse) {
  const { zipCodes } = req.body;

  if (!Array.isArray(zipCodes) || zipCodes.length === 0) {
    return res.status(400).json({ error: "zipCodes array is required" });
  }

  try {
    const result = await prisma.deliveryZoneZip.deleteMany({
      where: {
        deliveryZoneId: zoneId,
        zipCode: { in: zipCodes },
      },
    });

    return res.status(200).json({ deleted: result.count });
  } catch (error) {
    logError("Error deleting zone zips", error);
    return res.status(500).json({ error: "Failed to delete zip codes" });
  }
}
