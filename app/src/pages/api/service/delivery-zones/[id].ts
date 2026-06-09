// /app/src/pages/api/service/delivery-zones/[id].ts

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
  } else if (req.method === "PUT") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["MANAGER", "ADMIN"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const zone = await prisma.deliveryZone.findUnique({
      where: { id },
      include: { zipCodes: true },
    });

    if (!zone) return res.status(404).json({ error: "Delivery zone not found" });

    return res.status(200).json({
      ...zone,
      baseFee: Number(zone.baseFee),
      perPieceFee: zone.perPieceFee ? Number(zone.perPieceFee) : null,
    });
  } catch (error) {
    logError("Error fetching delivery zone", error);
    return res.status(500).json({ error: "Failed to fetch delivery zone" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  updatedBy: string | null,
) {
  const {
    name,
    description,
    baseFee,
    perPieceFee,
    isThirdParty,
    carrierName,
    sortOrder,
    isActive,
  } = req.body;

  try {
    const zone = await prisma.deliveryZone.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        description: description !== undefined ? description : undefined,
        baseFee: baseFee !== undefined ? baseFee : undefined,
        perPieceFee: perPieceFee !== undefined ? perPieceFee : undefined,
        isThirdParty: isThirdParty !== undefined ? isThirdParty : undefined,
        carrierName: carrierName !== undefined ? carrierName : undefined,
        sortOrder: sortOrder !== undefined ? sortOrder : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
        updatedBy,
      },
      include: { zipCodes: true },
    });

    return res.status(200).json({
      ...zone,
      baseFee: Number(zone.baseFee),
      perPieceFee: zone.perPieceFee ? Number(zone.perPieceFee) : null,
    });
  } catch (error) {
    logError("Error updating delivery zone", error);
    return res.status(500).json({ error: "Failed to update delivery zone" });
  }
}
