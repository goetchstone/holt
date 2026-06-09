// /app/src/pages/api/printers/index.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const where = search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { location: { contains: search, mode: "insensitive" as const } },
              { ipAddress: { contains: search, mode: "insensitive" as const } },
              { tagType: { contains: search, mode: "insensitive" as const } },
              { store: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {};

      const [printers, total] = await Promise.all([
        prisma.printer.findMany({
          where,
          skip,
          take: limit,
          orderBy: { name: "asc" },
        }),
        prisma.printer.count({ where }),
      ]);

      return res.status(200).json({ printers, total });
    } catch (err) {
      logError("GET /printers error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
    const { name, ipAddress, port, location, tagType, store, currentSize } = req.body;

    if (!name || !ipAddress || !port || !location || !tagType || !store) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const printer = await prisma.printer.create({
        data: {
          name,
          ipAddress,
          port: Number.parseInt(port, 10),
          location,
          tagType,
          store,
          currentSize: currentSize || null,
        },
      });
      return res.status(201).json(printer);
    } catch (err: unknown) {
      // Check for unique constraint violation (e.g., if IP address + name should be unique)
      if (getErrorCode(err) === "P2002") {
        return res
          .status(409)
          .json({ error: `Printer with name '${name}' or IP '${ipAddress}' already exists.` });
      }
      logError("POST /printers error", err);
      return res.status(500).json({ error: "Failed to create printer" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
