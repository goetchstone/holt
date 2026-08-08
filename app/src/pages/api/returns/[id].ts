// /app/src/pages/api/returns/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid return ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "PUT") {
    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const ret = await prisma.return.findUnique({
      where: { id },
      include: {
        salesOrder: { select: { id: true, orderno: true, storeLocation: true } },
        lineItem: {
          select: {
            id: true,
            productName: true,
            partNo: true,
            netPrice: true,
            orderedQuantity: true,
          },
        },
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            addresses: true,
          },
        },
        product: { select: { id: true, name: true, productNumber: true } },
        pickupAddress: true,
        receivedBy: { select: { id: true, displayName: true } },
        receivedLocation: { select: { id: true, name: true } },
        inspectedBy: { select: { id: true, displayName: true } },
        restockedLocation: { select: { id: true, name: true } },
        refundPayment: {
          select: { id: true, paymentAmount: true, paymentDate: true, method: true },
        },
        exchangeOrder: { select: { id: true, orderno: true, status: true } },
        vendorReturnPOs: { select: { id: true, poNumber: true, status: true } },
      },
    });

    if (!ret) return res.status(404).json({ error: "Return not found" });

    return res.status(200).json({
      ...ret,
      refundAmount: ret.refundAmount ? Number(ret.refundAmount) : null,
      refundPayment: ret.refundPayment
        ? { ...ret.refundPayment, paymentAmount: Number(ret.refundPayment.paymentAmount) }
        : null,
      lineItem: ret.lineItem
        ? {
            ...ret.lineItem,
            netPrice: Number(ret.lineItem.netPrice),
            orderedQuantity: Number(ret.lineItem.orderedQuantity),
          }
        : null,
    });
  } catch (error) {
    logError("Error fetching return", error);
    return res.status(500).json({ error: "Failed to fetch return" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  changedBy: string | null,
) {
  const { pickupAddressId, pickupDate, pickupTimeSlot, pickupNotes, reasonNotes } = req.body;

  try {
    const ret = await prisma.return.update({
      where: { id },
      data: {
        pickupAddressId:
          pickupAddressId !== undefined ? Number.parseInt(pickupAddressId) : undefined,
        pickupDate: pickupDate ? new Date(pickupDate) : undefined,
        pickupTimeSlot: pickupTimeSlot !== undefined ? pickupTimeSlot : undefined,
        pickupNotes: pickupNotes !== undefined ? pickupNotes : undefined,
        reasonNotes: reasonNotes !== undefined ? reasonNotes : undefined,
        updatedBy: changedBy,
      },
    });

    return res.status(200).json(ret);
  } catch (error) {
    logError("Error updating return", error);
    return res.status(500).json({ error: "Failed to update return" });
  }
}

export default requirePermission("sales.return", handler);
