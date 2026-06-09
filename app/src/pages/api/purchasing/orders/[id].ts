// /app/src/pages/api/purchasing/orders/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Purchase order ID is required." });
  }

  const poId = Number.parseInt(id, 10);
  if (Number.isNaN(poId)) {
    return res.status(400).json({ error: "Invalid purchase order ID." });
  }

  if (req.method === "GET") {
    return handleGet(poId, res);
  }

  if (req.method === "PUT") {
    return handlePut(poId, req, res, session);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(poId: number, res: NextApiResponse) {
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        vendor: { select: { id: true, name: true } },
        salesOrder: {
          select: {
            id: true,
            orderno: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        },
        lineItems: {
          include: {
            product: { select: { id: true, name: true, productNumber: true } },
            productVariant: { select: { id: true, upc: true, size: true, color: true } },
            orderLineItem: {
              select: { salesOrder: { select: { orderno: true } } },
            },
            receivingRecords: {
              orderBy: { receivedDate: "desc" },
            },
          },
        },
      },
    });

    if (!po) {
      return res.status(404).json({ error: "Purchase order not found." });
    }

    return res.status(200).json({
      id: po.id,
      poNumber: po.poNumber,
      vendor: po.vendor,
      salesOrder: po.salesOrder
        ? {
            id: po.salesOrder.id,
            orderno: po.salesOrder.orderno,
            customerName: po.salesOrder.customer
              ? `${po.salesOrder.customer.firstName ?? ""} ${po.salesOrder.customer.lastName ?? ""}`.trim()
              : null,
          }
        : null,
      orderDate: po.orderDate,
      expectedDelivery: po.expectedDelivery,
      estimatedShipDate: po.estimatedShipDate,
      vendorAckNumber: po.vendorAckNumber,
      vendorAckDate: po.vendorAckDate,
      status: po.status,
      notes: po.notes,
      created: po.created,
      updated: po.updated,
      lineItems: po.lineItems.map((item) => {
        const totalReceived = item.receivingRecords.reduce(
          (sum, r) => sum + Number(r.quantityReceived),
          0,
        );
        return {
          id: item.id,
          partNo: item.partNo,
          productName: item.product?.name || item.productName,
          productNumber: item.product?.productNumber,
          orderedQuantity: Number(item.orderedQuantity),
          unitCost: Number(item.unitCost),
          lineTotal: Number(item.orderedQuantity) * Number(item.unitCost),
          totalReceived,
          salesOrderNo: item.orderLineItem?.salesOrder?.orderno || null,
          selectedGrade: item.selectedGrade,
          productVariantId: item.productVariant?.id || null,
          variantUpc: item.productVariant?.upc || null,
          selectedFinish: item.selectedFinish,
          receivingRecords: item.receivingRecords.map((r) => ({
            id: r.id,
            quantityReceived: Number(r.quantityReceived),
            receivedDate: r.receivedDate,
            destinationLocation: r.destinationLocation,
            invoiceNumber: r.invoiceNumber,
            lineCost: r.lineCost != null ? Number(r.lineCost) : null,
            externalPorNo: r.externalPorNo,
          })),
        };
      }),
    });
  } catch (error) {
    logError("Error fetching purchase order", error);
    return res.status(500).json({ error: "Failed to fetch purchase order." });
  }
}

interface UpdateSession {
  user?: { email?: string | null };
}

async function handlePut(
  poId: number,
  req: NextApiRequest,
  res: NextApiResponse,
  session: UpdateSession,
) {
  try {
    const existing = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      select: { id: true, status: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "Purchase order not found." });
    }

    const { status, vendorAckNumber, vendorAckDate, estimatedShipDate, expectedDelivery, notes } =
      req.body;

    // Validate status transitions
    if (status) {
      const validTransitions: Record<string, string[]> = {
        DRAFT: ["SUBMITTED", "CANCELLED"],
        SUBMITTED: ["CONFIRMED", "CANCELLED"],
        CONFIRMED: ["RECEIVED_PARTIAL", "RECEIVED_FULL", "CANCELLED"],
        RECEIVED_PARTIAL: ["RECEIVED_FULL", "SHORT_CLOSED"],
      };

      const allowed = validTransitions[existing.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          error: `Cannot transition from ${existing.status} to ${status}.`,
        });
      }

      // Require ack number when moving to CONFIRMED
      if (status === "CONFIRMED" && !vendorAckNumber) {
        const current = await prisma.purchaseOrder.findUnique({
          where: { id: poId },
          select: { vendorAckNumber: true },
        });
        if (!current?.vendorAckNumber) {
          return res.status(400).json({
            error: "Vendor acknowledgement number is required to confirm.",
          });
        }
      }
    }

    const data: Record<string, unknown> = {
      updatedBy: session.user?.email || null,
    };

    if (status !== undefined) data.status = status;
    if (vendorAckNumber !== undefined) data.vendorAckNumber = vendorAckNumber || null;
    if (vendorAckDate !== undefined)
      data.vendorAckDate = vendorAckDate ? new Date(vendorAckDate) : null;
    if (estimatedShipDate !== undefined)
      data.estimatedShipDate = estimatedShipDate ? new Date(estimatedShipDate) : null;
    if (expectedDelivery !== undefined)
      data.expectedDelivery = expectedDelivery ? new Date(expectedDelivery) : null;
    if (notes !== undefined) data.notes = notes || null;

    const updated = await prisma.purchaseOrder.update({
      where: { id: poId },
      data,
      select: { id: true, status: true },
    });

    return res.status(200).json(updated);
  } catch (error) {
    logError("Error updating purchase order", error);
    return res.status(500).json({ error: "Failed to update purchase order." });
  }
}
