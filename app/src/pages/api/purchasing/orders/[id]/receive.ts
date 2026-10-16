// /app/src/pages/api/purchasing/orders/[id]/receive.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { lockProducts } from "@/lib/inventory/ledger";
import { receiveIntoStock } from "@/lib/inventory/receiving";
import { parseQty } from "@/lib/inventory/qtyInput";
import { nativeReceiptStatus } from "@/lib/purchasing/receiptStatus";

interface ReceiveItem {
  purchaseOrderItemId: number;
  quantityReceived: number;
  destinationStockLocationId?: number | null;
  condition?: string;
  printTag?: boolean;
  variantUpc?: string;
}

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Purchase order ID is required." });
  }

  const poId = Number.parseInt(id);
  if (Number.isNaN(poId)) {
    return res.status(400).json({ error: "Invalid purchase order ID." });
  }

  try {
    const { storeLocationId, items } = req.body as {
      storeLocationId: number;
      items: ReceiveItem[];
    };

    if (!storeLocationId) {
      return res.status(400).json({ error: "storeLocationId is required." });
    }

    // ReceivingRecord.receiverUserId is a foreign key to User.id (a CUID). This
    // route used to write the user's EMAIL there ("system" when absent), which
    // can never match a User.id, so every native receipt failed with a foreign
    // key violation. The POS import path resolves the id for the same reason
    // (lib/adapters/ordorite/runners.ts, resolveImportUserId).
    const receiverUserId = session.user?.id;
    if (!receiverUserId) {
      return res.status(401).json({ error: "Sign in again: your session has no user id." });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required." });
    }

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        lineItems: {
          include: {
            product: { select: { id: true } },
            productVariant: { select: { id: true, upc: true } },
            receivingRecords: { select: { quantityReceived: true } },
          },
        },
      },
    });

    if (!po) return res.status(404).json({ error: "Purchase order not found." });
    if (po.status === "CANCELLED") {
      return res.status(400).json({ error: "Cannot receive against a cancelled PO." });
    }

    const poItemIds = new Set(po.lineItems.map((li) => li.id));
    for (const item of items) {
      if (!poItemIds.has(item.purchaseOrderItemId)) {
        return res.status(400).json({
          error: `Item ${item.purchaseOrderItemId} does not belong to PO ${po.poNumber}.`,
        });
      }
      // A part roll arrives as a length: parsed, never truncated.
      const quantity = parseQty(item.quantityReceived);
      if (quantity == null) {
        return res.status(400).json({ error: "quantityReceived must be positive." });
      }
      item.quantityReceived = quantity;
    }

    const printItems: { productId: number; quantity: number }[] = [];

    const result = await prisma.$transaction(async (tx) => {
      const receivingRecords = [];

      // Lock every product on this receipt once, in ascending order, before
      // any stock moves. Locking them one at a time in request order could
      // take 9 then 2 while a sale takes 2 then 9, and deadlock.
      const receivedProductIds = items
        .map((item) => po.lineItems.find((li) => li.id === item.purchaseOrderItemId)?.product?.id)
        .filter((id): id is number => id != null);
      await lockProducts(tx, receivedProductIds);

      for (const item of items) {
        const poItem = po.lineItems.find((li) => li.id === item.purchaseOrderItemId);
        if (!poItem) continue;

        const record = await tx.receivingRecord.create({
          data: {
            purchaseOrderItemId: item.purchaseOrderItemId,
            purchaseOrderId: poId,
            quantityReceived: item.quantityReceived,
            receiverUserId,
            destinationLocationId: storeLocationId,
            destinationStockLocationId: item.destinationStockLocationId || null,
            condition: item.condition || null,
            tagsPrinted: item.printTag ?? false,
          },
        });

        receivingRecords.push(record);

        // Update variant UPC if provided during receiving
        if (item.variantUpc && poItem.productVariant && !poItem.productVariant.upc) {
          await tx.productVariant.update({
            where: { id: poItem.productVariant.id },
            data: { upc: item.variantUpc },
          });
        }

        if (poItem.product) {
          // Into the chosen place, the store's receiving place, or -- received
          // Damaged or Wrong Item -- its quarantine place; committed to the
          // order the line was raised for, up to what it still needs
          // (lib/inventory/receiving.ts). Through the single writer, which
          // merges into the existing row (rule 64).
          await receiveIntoStock(tx, {
            po,
            poItem,
            productId: poItem.product.id,
            quantity: item.quantityReceived,
            storeLocationId,
            stockLocationId: item.destinationStockLocationId,
            condition: item.condition,
            actor: session.user?.email || null,
          });

          if (item.printTag && poItem.product.id) {
            printItems.push({
              productId: poItem.product.id,
              quantity: item.quantityReceived,
            });
          }
        }
      }

      // Recalculate PO status based on total received vs ordered
      const updatedItems = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId: poId },
        include: { receivingRecords: { select: { quantityReceived: true } } },
      });

      // Zero-quantity lines are cancelled lines and count on neither side
      // (rule 39); nativeReceiptStatus says why.
      const newStatus = nativeReceiptStatus(
        updatedItems.map((ui) => ({
          ordered: Number(ui.orderedQuantity),
          received: ui.receivingRecords.reduce((sum, r) => sum + Number(r.quantityReceived), 0),
        })),
        po.status,
      );

      if (newStatus !== po.status) {
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: { status: newStatus, updatedBy: session.user?.email || null },
        });
      }

      return { receivingRecords, newStatus };
    });

    return res.status(200).json({
      message: `${result.receivingRecords.length} item(s) received`,
      receivingRecords: result.receivingRecords.map((r) => ({
        id: r.id,
        purchaseOrderItemId: r.purchaseOrderItemId,
        quantityReceived: Number(r.quantityReceived),
        condition: r.condition,
        tagsPrinted: r.tagsPrinted,
      })),
      newStatus: result.newStatus,
      printItems,
    });
  } catch (error) {
    logError("Error receiving items", error);
    return res.status(500).json({ error: "Failed to receive items." });
  }
}

export default requirePermission("purchasing.receive", handler);
