// /app/src/pages/api/warehouse/transfers/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 25;
      const search = (req.query.search as string)?.trim() || "";
      const status = (req.query.status as string) || null;

      const skip = (page - 1) * limit;

      const where: Prisma.InventoryTransferWhereInput = {};
      const conditions: Prisma.InventoryTransferWhereInput[] = [];

      if (status) conditions.push({ status: status as any });
      if (search) {
        conditions.push({
          OR: [
            { product: { name: { contains: search, mode: "insensitive" } } },
            { product: { productNumber: { contains: search, mode: "insensitive" } } },
            { fromLocation: { contains: search, mode: "insensitive" } },
            { toLocation: { contains: search, mode: "insensitive" } },
          ],
        });
      }

      if (conditions.length > 0) where.AND = conditions;

      const [transfers, total] = await Promise.all([
        prisma.inventoryTransfer.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created: "desc" },
          include: {
            product: { select: { id: true, name: true, productNumber: true } },
            fromStoreLocation: { select: { id: true, name: true, code: true } },
            toStoreLocation: { select: { id: true, name: true, code: true } },
            fromStockLocation: { select: { id: true, code: true, name: true } },
            toStockLocation: { select: { id: true, code: true, name: true } },
            requestedByUser: { select: { name: true, email: true } },
          },
        }),
        prisma.inventoryTransfer.count({ where }),
      ]);

      const safeTransfers = transfers.map((t) => ({
        id: t.id,
        productId: t.productId,
        productName: t.product.name,
        productNumber: t.product.productNumber,
        quantity: t.quantity,
        fromLocation: t.fromStoreLocation?.name || t.fromLocation,
        fromStockLocation: t.fromStockLocation?.name || null,
        toLocation: t.toStoreLocation?.name || t.toLocation,
        toStockLocation: t.toStockLocation?.name || null,
        status: t.status,
        notes: t.notes,
        requestedBy: t.requestedByUser.name || t.requestedByUser.email,
        shippedAt: t.shippedAt,
        receivedAt: t.receivedAt,
        created: t.created,
      }));

      return res.status(200).json({ transfers: safeTransfers, total });
    } catch (error) {
      logError("Error fetching transfers", error);
      return res.status(500).json({ error: "Failed to fetch transfers" });
    }
  }

  if (req.method === "POST") {
    // Creating an inventory transfer is a warehouse operation.
    const role = (session as unknown as { role?: string })?.role;
    if (role !== "WAREHOUSE" && role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Warehouse, Manager, or Admin role required" });
    }
    try {
      const {
        productId,
        fromLocationId,
        fromStockLocationId,
        toLocationId,
        toStockLocationId,
        quantity,
        notes,
      } = req.body;

      if (!productId || !fromLocationId || !toLocationId || !quantity) {
        return res
          .status(400)
          .json({ error: "productId, fromLocationId, toLocationId, and quantity are required." });
      }

      const [fromLoc, toLoc] = await Promise.all([
        prisma.storeLocation.findUnique({
          where: { id: fromLocationId },
          select: { name: true },
        }),
        prisma.storeLocation.findUnique({
          where: { id: toLocationId },
          select: { name: true },
        }),
      ]);

      if (!fromLoc || !toLoc) {
        return res.status(400).json({ error: "Invalid location ID." });
      }

      const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true },
      });

      if (!user) {
        return res.status(400).json({ error: "User record not found." });
      }

      const transfer = await prisma.inventoryTransfer.create({
        data: {
          productId,
          quantity,
          fromLocation: fromLoc.name,
          toLocation: toLoc.name,
          fromLocationId,
          fromStockLocationId: fromStockLocationId || null,
          toLocationId,
          toStockLocationId: toStockLocationId || null,
          notes: notes || null,
          requestedByUserId: user.id,
          status: "DRAFT",
        },
      });

      return res.status(201).json(transfer);
    } catch (error) {
      logError("Error creating transfer", error);
      return res.status(500).json({ error: "Failed to create transfer" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
