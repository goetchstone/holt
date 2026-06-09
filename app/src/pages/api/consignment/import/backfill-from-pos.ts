// /app/src/pages/api/consignment/import/backfill-from-pos.ts
//
// One-time backfill endpoint that syncs ConsignmentItem statuses from the POS data:
// 1. Marks ON_FLOOR/ON_APPROVAL items as SOLD if they appear on SalesOrders
// 2. Marks SOLD items as PAID if they appear on RECEIVED_FULL Marjan POs
// 3. Flags ON_FLOOR items as creditOwed if they appear on received POs (returned after payment)
//
// Supports dry-run mode via ?dryRun=true query parameter.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { toMarjanCustomerNumber } from "@/lib/consignment";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const dryRun = req.query.dryRun === "true";
    const userEmail = session.user.email;

    try {
      const marjanVendor = await prisma.vendor.findFirst({
        where: { name: { contains: "Marjan", mode: "insensitive" } },
        select: { id: true },
      });
      if (!marjanVendor) return res.status(404).json({ error: "Marjan vendor not found" });

      const results = {
        soldSynced: 0,
        paidSynced: 0,
        batchesCreated: 0,
        creditsDetected: 0,
        details: [] as string[],
      };

      // Step 1: Mark ON_FLOOR/ON_APPROVAL items as SOLD if they have matching SalesOrders.
      const soldLineItems = await prisma.orderLineItem.findMany({
        where: {
          product: { vendorId: marjanVendor.id },
          salesOrder: { status: { in: ["ORDER", "FULFILLED"] } },
        },
        include: {
          product: { select: { productNumber: true } },
          salesOrder: { select: { id: true, orderno: true, orderDate: true } },
        },
      });

      for (const li of soldLineItems) {
        const cn = li.product ? toMarjanCustomerNumber(li.product.productNumber) : null;
        if (!cn) continue;

        const item = await prisma.consignmentItem.findFirst({
          where: { customerNumber: cn, status: { in: ["ON_FLOOR", "ON_APPROVAL"] } },
          select: { id: true, barcode: true },
        });
        if (!item) continue;

        results.details.push(
          `SOLD: ${item.barcode} (custNum ${cn}) → order ${li.salesOrder.orderno}`,
        );
        if (!dryRun) {
          await prisma.consignmentItem.update({
            where: { id: item.id },
            data: {
              status: "SOLD",
              salesOrderId: li.salesOrder.id,
              saleDate: li.salesOrder.orderDate,
              updatedBy: userEmail,
            },
          });
        }
        results.soldSynced++;
      }

      // Step 2: Mark SOLD items as PAID if they appear on RECEIVED_FULL Marjan POs.
      const receivedPOs = await prisma.purchaseOrder.findMany({
        where: { vendorId: marjanVendor.id, status: "RECEIVED_FULL" },
        include: {
          consignmentPaymentBatch: { select: { id: true } },
          lineItems: { select: { partNo: true, unitCost: true } },
        },
      });

      for (const po of receivedPOs) {
        if (po.consignmentPaymentBatch) continue;

        const customerNumbers = po.lineItems
          .map((item: { partNo: string | null }) =>
            item.partNo ? toMarjanCustomerNumber(item.partNo) : null,
          )
          .filter((cn: string | null): cn is string => cn !== null);

        if (customerNumbers.length === 0) continue;

        const matchingItems = await prisma.consignmentItem.findMany({
          where: { customerNumber: { in: customerNumbers }, status: "SOLD" },
          select: { id: true, barcode: true, customerNumber: true, cost: true },
        });

        if (matchingItems.length === 0) continue;

        const totalAmount = matchingItems.reduce((sum, item) => sum + Number(item.cost || 0), 0);

        let batchId: number;
        if (!dryRun) {
          const batch = await prisma.consignmentPaymentBatch.create({
            data: {
              vendorId: marjanVendor.id,
              batchDate: po.orderDate,
              periodStart: po.orderDate,
              periodEnd: po.orderDate,
              totalAmount,
              itemCount: matchingItems.length,
              isPaid: true,
              purchaseOrderId: po.id,
              notes: `Backfill from ${po.poNumber}`,
              createdBy: userEmail,
            },
          });
          batchId = batch.id;
        } else {
          batchId = 0;
        }
        results.batchesCreated++;

        for (const item of matchingItems) {
          results.details.push(
            `PAID: ${item.barcode} (custNum ${item.customerNumber}) → ${po.poNumber}`,
          );
          if (!dryRun) {
            await prisma.consignmentItem.update({
              where: { id: item.id },
              data: {
                status: "PAID",
                paidDate: po.orderDate,
                consignmentPaymentBatchId: batchId,
                updatedBy: userEmail,
              },
            });
          }
          results.paidSynced++;
        }
      }

      // Step 3: Detect ON_FLOOR items on received POs (returned after payment → credit owed).
      for (const po of receivedPOs) {
        const customerNumbers = po.lineItems
          .map((item: { partNo: string | null }) =>
            item.partNo ? toMarjanCustomerNumber(item.partNo) : null,
          )
          .filter((cn: string | null): cn is string => cn !== null);

        if (customerNumbers.length === 0) continue;

        const creditItems = await prisma.consignmentItem.findMany({
          where: {
            customerNumber: { in: customerNumbers },
            status: "ON_FLOOR",
            creditOwed: false,
          },
          select: { id: true, barcode: true, customerNumber: true },
        });

        for (const item of creditItems) {
          results.details.push(
            `CREDIT: ${item.barcode} (custNum ${item.customerNumber}) on ${po.poNumber} — ON_FLOOR but was paid`,
          );
          if (!dryRun) {
            await prisma.consignmentItem.update({
              where: { id: item.id },
              data: { creditOwed: true, updatedBy: userEmail },
            });
          }
          results.creditsDetected++;
        }
      }

      return res.status(200).json({ dryRun, ...results });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  },
);
