// /app/src/pages/api/consignment/items/[id].ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { canViewCost, dropCostWrites, WITH_COST } from "@/lib/auth/costVisibility";
import { prisma } from "@/lib/prisma";
import { isValidConsignmentTransition, parseRugCost } from "@/lib/consignment";
import type { ConsignmentItemStatus } from "@prisma/client";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  // A rug's cost goes only to a holder of "View cost", and only a holder's
  // edit can change it; tag prices go to everyone this route admits.
  const showCost = canViewCost(access);
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    const item = await prisma.consignmentItem.findUnique({
      where: { id },
      omit: { cost: !showCost },
      include: {
        vendor: { select: { id: true, name: true } },
        product: { select: { id: true, name: true, productNumber: true } },
        storeLocation: { select: { id: true, name: true } },
        salesOrder: { select: { id: true, orderno: true } },
        consignmentReceipt: true,
        // The batch's identity and paid state, never its total (what was paid
        // to the consignor); no screen reads the total here.
        consignmentPaymentBatch: {
          select: { id: true, batchDate: true, checkNumber: true, isPaid: true },
        },
      },
    });

    if (!item) return res.status(404).json({ error: "Consignment item not found" });

    return res.json({
      ...item,
      ...(showCost ? { cost: Number(item.cost) } : {}),
      anchorPrice: item.anchorPrice ? Number(item.anchorPrice) : null,
      retailPrice: item.retailPrice ? Number(item.retailPrice) : null,
      sellingPrice: item.sellingPrice ? Number(item.sellingPrice) : null,
      wasPrice: item.wasPrice ? Number(item.wasPrice) : null,
      costVisible: showCost,
    });
  }

  if (req.method === "PUT") {
    const existing = await prisma.consignmentItem.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Consignment item not found" });

    const { status, ...raw } = req.body;
    const rest = dropCostWrites(access, raw as Record<string, unknown>, ["cost"]) as Record<
      string,
      any // eslint-disable-line @typescript-eslint/no-explicit-any
    >;

    if (status && status !== existing.status) {
      if (!isValidConsignmentTransition(existing.status as ConsignmentItemStatus, status)) {
        return res.status(400).json({
          error: `Invalid status transition from ${existing.status} to ${status}`,
        });
      }
    }

    const data: any = { updatedBy: session.user?.email ?? null };

    if (status !== undefined) data.status = status;
    if (rest.barcode !== undefined) data.barcode = rest.barcode;
    if (rest.vendorId !== undefined) data.vendorId = rest.vendorId;
    if (rest.cost !== undefined) {
      const cost = parseRugCost(rest.cost);
      if (cost === null) {
        return res.status(400).json({ error: "cost must be a non-negative number" });
      }
      data.cost = cost;
    }
    if (rest.anchorPrice !== undefined) data.anchorPrice = Number(rest.anchorPrice);
    if (rest.retailPrice !== undefined) data.retailPrice = Number(rest.retailPrice);
    if (rest.sellingPrice !== undefined) data.sellingPrice = Number(rest.sellingPrice);
    if (rest.wasPrice !== undefined) data.wasPrice = Number(rest.wasPrice);
    if (rest.quality !== undefined) data.quality = rest.quality;
    if (rest.size !== undefined) data.size = rest.size;
    if (rest.year !== undefined) data.year = rest.year ? Number.parseInt(rest.year) : null;
    if (rest.storeLocationId !== undefined) data.storeLocationId = rest.storeLocationId;
    if (rest.rugNumber !== undefined) data.rugNumber = rest.rugNumber;
    if (rest.productId !== undefined) data.productId = rest.productId;

    try {
      const updated = await prisma.consignmentItem.update({
        where: { id },
        data,
        omit: { cost: !showCost },
        include: {
          vendor: { select: { id: true, name: true } },
          storeLocation: { select: { id: true, name: true } },
        },
      });

      return res.json({
        ...updated,
        ...(showCost ? { cost: Number(updated.cost) } : {}),
        anchorPrice: updated.anchorPrice ? Number(updated.anchorPrice) : null,
        retailPrice: updated.retailPrice ? Number(updated.retailPrice) : null,
        sellingPrice: updated.sellingPrice ? Number(updated.sellingPrice) : null,
        wasPrice: updated.wasPrice ? Number(updated.wasPrice) : null,
        costVisible: showCost,
      });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "Barcode already exists" });
      }
      logError("Error updating consignment item", err);
      return res.status(500).json({ error: "Failed to update consignment item" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default requireAuthWithRole(["MANAGER", "ADMIN", "WAREHOUSE"], handler, WITH_COST);
