// /app/src/pages/api/consignment/po-management/po-items.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { toMarjanCustomerNumber } from "@/lib/consignment";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const purchaseOrderId = Number.parseInt(req.query.purchaseOrderId as string);
  if (Number.isNaN(purchaseOrderId)) {
    return res.status(400).json({ error: "purchaseOrderId is required" });
  }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      vendor: { select: { id: true, name: true } },
      consignmentPaymentBatch: { select: { id: true } },
      lineItems: {
        select: {
          id: true,
          partNo: true,
          productName: true,
          unitCost: true,
          orderedQuantity: true,
        },
      },
    },
  });

  if (!po) {
    return res.status(404).json({ error: "Purchase order not found" });
  }

  // For each MAR-* line item, find the matching ConsignmentItem
  const customerNumbers = po.lineItems
    .map((li) => toMarjanCustomerNumber(li.partNo || ""))
    .filter((cn): cn is string => cn !== null);

  const consignmentItems =
    customerNumbers.length > 0
      ? await prisma.consignmentItem.findMany({
          where: { customerNumber: { in: customerNumbers } },
          select: {
            id: true,
            barcode: true,
            customerNumber: true,
            quality: true,
            size: true,
            cost: true,
            status: true,
            saleDate: true,
            paidDate: true,
            consignmentPaymentBatchId: true,
          },
        })
      : [];

  // Build a lookup by customerNumber
  const ciByCustomerNumber = new Map<string, (typeof consignmentItems)[number]>();
  for (const ci of consignmentItems) {
    if (ci.customerNumber) {
      ciByCustomerNumber.set(ci.customerNumber, ci);
    }
  }

  let unmatchedCount = 0;
  const lineItems = po.lineItems.map((li) => {
    const customerNumber = toMarjanCustomerNumber(li.partNo || "");
    const match = customerNumber ? (ciByCustomerNumber.get(customerNumber) ?? null) : null;
    if (!match && customerNumber) unmatchedCount++;
    return {
      id: li.id,
      partNo: li.partNo,
      productName: li.productName,
      unitCost: li.unitCost ? Number(li.unitCost) : null,
      orderedQuantity: Number(li.orderedQuantity),
      customerNumber,
      consignmentItem: match
        ? {
            ...match,
            cost: Number(match.cost),
          }
        : null,
    };
  });

  return res.json({
    po: {
      id: po.id,
      poNumber: po.poNumber,
      orderDate: po.orderDate,
      status: po.status,
      vendorId: po.vendor.id,
      vendorName: po.vendor.name,
      hasBatch: po.consignmentPaymentBatch !== null,
      batchId: po.consignmentPaymentBatch?.id ?? null,
    },
    lineItems,
    unmatchedCount,
  });
});
