// /app/src/pages/api/warehouse/locations/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const { type, isActive } = req.query;

      const where: Record<string, unknown> = {};
      if (type && typeof type === "string") {
        where.type = type;
      }
      if (isActive === "true") {
        where.isActive = true;
      } else if (isActive === "false") {
        where.isActive = false;
      }

      const locations = await prisma.storeLocation.findMany({
        where,
        orderBy: { sortOrder: "asc" },
        include: {
          stockLocations: {
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              code: true,
              name: true,
              description: true,
              building: true,
              floor: true,
              area: true,
              locationType: true,
              squareFootage: true,
              isActive: true,
              sortOrder: true,
            },
          },
        },
      });
      return res.status(200).json({ locations });
    } catch (error) {
      logError("Error fetching locations", error);
      return res.status(500).json({ error: "Failed to fetch locations" });
    }
  }

  if (req.method === "POST") {
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Manager role required" });
    }

    try {
      const {
        name,
        code,
        type,
        address,
        city,
        state,
        zip,
        externalLocationName,
        isActive,
        sortOrder,
      } = req.body;

      if (!name || !code || !type) {
        return res.status(400).json({ error: "Name, code, and type are required." });
      }

      const resolvedSortOrder =
        sortOrder !== undefined
          ? Number.parseInt(sortOrder)
          : ((await prisma.storeLocation.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ??
              0) + 1;

      const location = await prisma.storeLocation.create({
        data: {
          name,
          code: code.toUpperCase(),
          type,
          address: address || null,
          city: city || null,
          state: state || null,
          zip: zip || null,
          externalLocationName: externalLocationName || null,
          isActive: isActive !== undefined ? isActive : true,
          sortOrder: resolvedSortOrder,
          createdBy: session.user?.email || null,
        },
      });

      return res.status(201).json(location);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        return res.status(409).json({ error: "A location with that name or code already exists." });
      }
      logError("Error creating location", error);
      return res.status(500).json({ error: "Failed to create location" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
