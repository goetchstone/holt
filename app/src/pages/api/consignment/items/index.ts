// /app/src/pages/api/consignment/items/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { calculateRugPricing } from "@/lib/consignment";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 50;
      const skip = (page - 1) * limit;
      const status = req.query.status as string | undefined;
      const search = (req.query.search as string)?.trim() || "";

      const where: any = {};

      if (status) {
        where.status = status;
      }

      if (search) {
        where.OR = [
          { barcode: { contains: search, mode: "insensitive" as const } },
          { quality: { contains: search, mode: "insensitive" as const } },
          { rugNumber: { contains: search, mode: "insensitive" as const } },
        ];
      }

      const [items, total] = await Promise.all([
        prisma.consignmentItem.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created: "desc" },
          include: {
            vendor: { select: { id: true, name: true } },
            storeLocation: { select: { id: true, name: true } },
          },
        }),
        prisma.consignmentItem.count({ where }),
      ]);

      const safeItems = items.map((item) => ({
        ...item,
        cost: Number(item.cost),
        anchorPrice: item.anchorPrice ? Number(item.anchorPrice) : null,
        retailPrice: item.retailPrice ? Number(item.retailPrice) : null,
        sellingPrice: item.sellingPrice ? Number(item.sellingPrice) : null,
        wasPrice: item.wasPrice ? Number(item.wasPrice) : null,
      }));

      return res.json({ items: safeItems, total, page, limit });
    } catch (error) {
      logError("Error listing consignment items", error);
      return res.status(500).json({ error: "Failed to list consignment items" });
    }
  }

  if (req.method === "POST") {
    try {
      const { barcode, vendorId, cost, quality, size, year, storeLocationId } = req.body;

      if (!barcode || !vendorId || cost == null) {
        return res.status(400).json({ error: "barcode, vendorId, and cost are required" });
      }

      const numericCost = Number(cost);
      if (Number.isNaN(numericCost) || numericCost < 0) {
        return res.status(400).json({ error: "cost must be a non-negative number" });
      }

      const { anchorPrice, retailPrice } = calculateRugPricing(numericCost);

      const item = await prisma.consignmentItem.create({
        data: {
          barcode,
          vendorId,
          cost: numericCost,
          anchorPrice,
          retailPrice,
          quality: quality || null,
          size: size || null,
          year: year ? Number.parseInt(year) : null,
          storeLocationId: storeLocationId || null,
          createdBy: session.user?.email ?? null,
        },
        include: {
          vendor: { select: { id: true, name: true } },
          storeLocation: { select: { id: true, name: true } },
        },
      });

      return res.status(201).json({
        ...item,
        cost: Number(item.cost),
        anchorPrice: item.anchorPrice ? Number(item.anchorPrice) : null,
        retailPrice: item.retailPrice ? Number(item.retailPrice) : null,
        sellingPrice: item.sellingPrice ? Number(item.sellingPrice) : null,
        wasPrice: item.wasPrice ? Number(item.wasPrice) : null,
      });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "Barcode already exists" });
      }
      logError("Error creating consignment item", err);
      return res.status(500).json({ error: "Failed to create consignment item" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
