// /app/src/pages/api/purchasing/orders/[id]/receive.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

interface ReceiveItem {
  purchaseOrderItemId: number;
  quantityReceived: number;
  destinationStockLocationId?: number | null;
  condition?: string;
  printTag?: boolean;
  variantUpc?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
      if (!item.quantityReceived || item.quantityReceived <= 0) {
        return res.status(400).json({ error: "quantityReceived must be positive." });
      }
    }

    const printItems: { productId: number; quantity: number }[] = [];

    const result = await prisma.$transaction(async (tx) => {
      const receivingRecords = [];

      for (const item of items) {
        const poItem = po.lineItems.find((li) => li.id === item.purchaseOrderItemId);
        if (!poItem) continue;

        const record = await tx.receivingRecord.create({
          data: {
            purchaseOrderItemId: item.purchaseOrderItemId,
            purchaseOrderId: poId,
            quantityReceived: item.quantityReceived,
            receiverUserId: session.user?.email || "system",
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
          await tx.inventoryPosition.upsert({
            where: {
              productId_storeLocationId_stockLocationId_salesOrderId: {
                productId: poItem.product.id,
                storeLocationId,
                stockLocationId: (item.destinationStockLocationId ?? null) as number,
                salesOrderId: null as unknown as number,
              },
            },
            update: {
              quantity: { increment: item.quantityReceived },
              updatedBy: session.user?.email || null,
            },
            create: {
              productId: poItem.product.id,
              storeLocationId,
              stockLocationId: item.destinationStockLocationId || null,
              quantity: item.quantityReceived,
              createdBy: session.user?.email || null,
            },
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

      let allReceived = true;
      let anyReceived = false;
      for (const ui of updatedItems) {
        const totalReceived = ui.receivingRecords.reduce(
          (sum, r) => sum + Number(r.quantityReceived),
          0,
        );
        if (totalReceived >= Number(ui.orderedQuantity)) {
          anyReceived = true;
        } else {
          allReceived = false;
          if (totalReceived > 0) anyReceived = true;
        }
      }

      let newStatus = po.status;
      if (allReceived && updatedItems.length > 0) {
        newStatus = "RECEIVED_FULL";
      } else if (anyReceived) {
        newStatus = "RECEIVED_PARTIAL";
      }

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
