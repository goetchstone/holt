// /app/src/pages/api/warehouse/positions/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 25;
      const search = (req.query.search as string)?.trim() || "";
      const locationId = req.query.locationId
        ? Number.parseInt(req.query.locationId as string)
        : null;
      const stockLocationId = req.query.stockLocationId
        ? Number.parseInt(req.query.stockLocationId as string)
        : null;

      const skip = (page - 1) * limit;

      const where: Prisma.InventoryPositionWhereInput = {};
      const conditions: Prisma.InventoryPositionWhereInput[] = [];

      if (locationId) conditions.push({ storeLocationId: locationId });
      if (stockLocationId) conditions.push({ stockLocationId });
      if (search) {
        conditions.push({
          OR: [
            { product: { name: { contains: search, mode: "insensitive" } } },
            { product: { productNumber: { contains: search, mode: "insensitive" } } },
            { salesOrder: { orderno: { contains: search, mode: "insensitive" } } },
          ],
        });
      }

      if (conditions.length > 0) where.AND = conditions;

      const [positions, total] = await Promise.all([
        prisma.inventoryPosition.findMany({
          where,
          skip,
          take: limit,
          orderBy: { updated: "desc" },
          include: {
            product: { select: { id: true, name: true, productNumber: true } },
            storeLocation: { select: { id: true, name: true, code: true } },
            stockLocation: { select: { id: true, code: true, name: true } },
            salesOrder: { select: { id: true, orderno: true } },
          },
        }),
        prisma.inventoryPosition.count({ where }),
      ]);

      const safePositions = positions.map((p) => ({
        id: p.id,
        productId: p.productId,
        productName: p.product.name,
        productNumber: p.product.productNumber,
        storeLocationId: p.storeLocationId,
        locationName: p.storeLocation.name,
        locationCode: p.storeLocation.code,
        stockLocationId: p.stockLocationId,
        stockLocationName: p.stockLocation?.name || null,
        stockLocationCode: p.stockLocation?.code || null,
        quantity: p.quantity,
        salesOrderId: p.salesOrderId,
        salesOrderNo: p.salesOrder?.orderno || null,
        notes: p.notes,
        updated: p.updated || p.created,
      }));

      return res.status(200).json({ positions: safePositions, total });
    } catch (error) {
      logError("Error fetching positions", error);
      return res.status(500).json({ error: "Failed to fetch inventory positions" });
    }
  }

  if (req.method === "POST") {
    // Inventory mutations belong to warehouse staff. Designer / register /
    // marketing have no workflow reason to create positions directly.
    const role = (session as unknown as { role?: string })?.role;
    if (role !== "WAREHOUSE" && role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Warehouse, Manager, or Admin role required" });
    }
    try {
      const { productId, storeLocationId, stockLocationId, quantity, salesOrderId, notes } =
        req.body;

      if (!productId || !storeLocationId) {
        return res.status(400).json({ error: "productId and storeLocationId are required." });
      }

      const position = await prisma.inventoryPosition.upsert({
        where: {
          productId_storeLocationId_stockLocationId_salesOrderId: {
            productId,
            storeLocationId,
            stockLocationId: stockLocationId ?? null,
            salesOrderId: salesOrderId ?? null,
          },
        },
        update: {
          quantity: quantity ?? 1,
          notes: notes ?? null,
          updatedBy: session.user?.email || null,
        },
        create: {
          productId,
          storeLocationId,
          stockLocationId: stockLocationId ?? null,
          quantity: quantity ?? 1,
          salesOrderId: salesOrderId ?? null,
          notes: notes ?? null,
          createdBy: session.user?.email || null,
        },
      });

      return res.status(201).json(position);
    } catch (error) {
      logError("Error creating position", error);
      return res.status(500).json({ error: "Failed to create inventory position" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
