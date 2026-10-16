// /app/src/pages/api/warehouse/transfers/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { toQty } from "@/lib/inventory/quantity";
import { parseQty } from "@/lib/inventory/qtyInput";
import { InsufficientStockError, lockProducts } from "@/lib/inventory/ledger";
import { MoveModeError, quickMove, transferForClient } from "@/lib/inventory/transfers";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
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
        quantity: toQty(t.quantity),
        receivedQuantity: toQty(t.receivedQuantity),
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
    // Creating an inventory transfer is a warehouse operation -- same role
    // set as the outer gate.
    try {
      const {
        productId,
        fromLocationId,
        fromStockLocationId,
        toLocationId,
        toStockLocationId,
        salesOrderId,
        notes,
        moveNow,
      } = req.body;
      // A part roll moves as a length: parsed, never truncated with parseInt.
      const quantity = parseQty(req.body.quantity);

      if (!productId || !fromLocationId || !toLocationId || quantity == null) {
        return res.status(400).json({
          error: "productId, fromLocationId, toLocationId, and a positive quantity are required.",
        });
      }

      // A named place must be at the store it is named for, or the units would
      // be recorded at one store in another store's stock room.
      for (const [stockId, storeId, side] of [
        [fromStockLocationId, fromLocationId, "from"],
        [toStockLocationId, toLocationId, "to"],
      ] as const) {
        if (!stockId) continue;
        const place = await prisma.stockLocation.findUnique({
          where: { id: Number(stockId) },
          select: { storeLocationId: true },
        });
        if (!place || place.storeLocationId !== Number(storeId)) {
          return res
            .status(400)
            .json({ error: `The ${side} stock location is not at the ${side} store.` });
        }
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
        where: { email: session.user.email! },
        select: { id: true },
      });

      if (!user) {
        return res.status(400).json({ error: "User record not found." });
      }

      // A transfer FOR an order must name a real one. Accepting a dangling id
      // would produce exactly the thing this link exists to prevent: a move
      // nobody can trace back to the sale that needed it.
      if (salesOrderId != null) {
        const order = await prisma.salesOrder.findUnique({
          where: { id: salesOrderId },
          select: { id: true },
        });
        if (!order) {
          return res.status(400).json({ error: `Sales order ${salesOrderId} not found.` });
        }
      }

      const data = {
        productId,
        quantity,
        fromLocation: fromLoc.name,
        toLocation: toLoc.name,
        fromLocationId,
        fromStockLocationId: fromStockLocationId || null,
        toLocationId,
        toStockLocationId: toStockLocationId || null,
        notes: notes || null,
        // The order this move serves, when it serves one. Validated above, so
        // a bad id is a 400 rather than a transfer silently linked to nothing.
        salesOrderId: salesOrderId ?? null,
        requestedByUserId: user.id,
      };

      // "Move now": one movement from a named place to a named place, where
      // the two ends' move mode allows a quick move. Recorded as a transfer
      // that is already received, so the move is still a document.
      if (moveNow) {
        if (!fromStockLocationId || !toStockLocationId) {
          return res.status(400).json({ error: "Moving now needs both stock locations named." });
        }
        const actor = session.user.email ?? null;
        const moved = await prisma.$transaction(async (tx) => {
          const created = await tx.inventoryTransfer.create({
            data: {
              ...data,
              status: "RECEIVED",
              receivedQuantity: quantity,
              shippedAt: new Date(),
              receivedAt: new Date(),
              receivedByUserId: actor,
            },
          });
          await lockProducts(tx, [productId]);
          await quickMove(tx, {
            productId,
            quantity,
            from: {
              storeLocationId: fromLocationId,
              stockLocationId: Number(fromStockLocationId),
              salesOrderId: null,
            },
            to: {
              storeLocationId: toLocationId,
              stockLocationId: Number(toStockLocationId),
              salesOrderId: null,
            },
            actor,
            source: { type: "InventoryTransfer", id: created.id },
          });
          return created;
        });
        return res.status(201).json(transferForClient(moved));
      }

      const transfer = await prisma.inventoryTransfer.create({
        data: { ...data, status: "DRAFT" },
      });

      return res.status(201).json(transferForClient(transfer));
    } catch (error) {
      if (error instanceof MoveModeError) return res.status(409).json({ error: error.message });
      if (error instanceof InsufficientStockError) {
        return res.status(409).json({
          error: `Only ${error.available} are at that stock location; ${error.requested} requested.`,
        });
      }
      logError("Error creating transfer", error);
      return res.status(500).json({ error: "Failed to create transfer" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("inventory.transfer", handler);
