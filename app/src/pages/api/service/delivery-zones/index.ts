// /app/src/pages/api/service/delivery-zones/index.ts

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
    if (!["MANAGER", "ADMIN"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePost(req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const zipCode = req.query.zipCode as string | undefined;

  try {
    if (zipCode) {
      const zoneZip = await prisma.deliveryZoneZip.findFirst({
        where: { zipCode },
        include: {
          deliveryZone: {
            include: { _count: { select: { zipCodes: true } } },
          },
        },
      });

      if (!zoneZip) return res.status(200).json(null);

      return res.status(200).json({
        ...zoneZip.deliveryZone,
        baseFee: Number(zoneZip.deliveryZone.baseFee),
        perPieceFee: zoneZip.deliveryZone.perPieceFee
          ? Number(zoneZip.deliveryZone.perPieceFee)
          : null,
      });
    }

    const zones = await prisma.deliveryZone.findMany({
      include: { _count: { select: { zipCodes: true } } },
      orderBy: { sortOrder: "asc" },
    });

    const mapped = zones.map((z) => ({
      ...z,
      baseFee: Number(z.baseFee),
      perPieceFee: z.perPieceFee ? Number(z.perPieceFee) : null,
    }));

    return res.status(200).json(mapped);
  } catch (error) {
    logError("Error fetching delivery zones", error);
    return res.status(500).json({ error: "Failed to fetch delivery zones" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string | null) {
  const { name, description, baseFee, perPieceFee, isThirdParty, carrierName, sortOrder } =
    req.body;

  if (!name || baseFee === undefined) {
    return res.status(400).json({ error: "name and baseFee are required" });
  }

  try {
    const zone = await prisma.deliveryZone.create({
      data: {
        name,
        description: description || undefined,
        baseFee,
        perPieceFee: perPieceFee !== undefined ? perPieceFee : undefined,
        isThirdParty: isThirdParty || false,
        carrierName: carrierName || undefined,
        sortOrder: sortOrder !== undefined ? sortOrder : undefined,
        createdBy,
      },
      include: { _count: { select: { zipCodes: true } } },
    });

    return res.status(201).json({
      ...zone,
      baseFee: Number(zone.baseFee),
      perPieceFee: zone.perPieceFee ? Number(zone.perPieceFee) : null,
    });
  } catch (error) {
    logError("Error creating delivery zone", error);
    return res.status(500).json({ error: "Failed to create delivery zone" });
  }
}
