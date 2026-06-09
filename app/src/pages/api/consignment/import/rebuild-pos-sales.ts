// /app/src/pages/api/consignment/import/rebuild-pos-sales.ts
//
// One-time (idempotent) endpoint that builds ConsignmentSale + ConsignmentSaleLine
// records for all SOLD ConsignmentItems that were linked to POS orders. Safe to
// run multiple times — uses upsert for sales and skips existing lines.
//
// Also repairs the status of any SOLD item that already has a consignmentPaymentBatchId
// set: those items should be PAID, not SOLD.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const userEmail = session.user?.email ?? "admin";

    try {
      // Fetch all SOLD items that have a saleTransactionId (the POS-linked sales).
      // Items without saleTransactionId are legacy import-only records.
      const soldItems = await prisma.consignmentItem.findMany({
        where: { status: "SOLD", saleTransactionId: { not: null } },
        select: {
          id: true,
          barcode: true,
          cost: true,
          saleDate: true,
          saleTransactionId: true,
          saleCustomerName: true,
          consignmentPaymentBatchId: true,
          consignmentPaymentBatch: {
            select: { batchDate: true },
          },
        },
      });

      // Also fetch PAID items in case the endpoint is run again after partial completion
      const paidItems = await prisma.consignmentItem.findMany({
        where: { status: "PAID", saleTransactionId: { not: null } },
        select: {
          id: true,
          barcode: true,
          cost: true,
          saleDate: true,
          saleTransactionId: true,
          saleCustomerName: true,
        },
      });

      const allItems = [...soldItems, ...paidItems];

      // Group items by saleTransactionId
      const byTx = new Map<
        string,
        {
          id: number;
          barcode: string;
          cost: unknown;
          saleDate: Date | null;
          saleCustomerName: string | null;
        }[]
      >();
      for (const item of allItems) {
        const txId = item.saleTransactionId!;
        if (!byTx.has(txId)) byTx.set(txId, []);
        byTx.get(txId)!.push(item);
      }

      let salesCreated = 0;
      let salesUpdated = 0;
      let linesCreated = 0;
      let linesSkipped = 0;

      // Build / update a ConsignmentSale + ConsignmentSaleLines for each transaction
      for (const [txId, items] of byTx) {
        const totalCost = items.reduce((sum, i) => sum + Number(i.cost), 0);
        const saleDate = items.find((i) => i.saleDate)?.saleDate ?? new Date();
        const customerName = items.find((i) => i.saleCustomerName)?.saleCustomerName ?? null;

        const existingSale = await prisma.consignmentSale.findUnique({
          where: { transactionId: txId },
        });

        const sale = existingSale
          ? await prisma.consignmentSale.update({
              where: { transactionId: txId },
              data: { totalCost: Math.round(totalCost * 100) / 100 },
            })
          : await prisma.consignmentSale.create({
              data: {
                transactionId: txId,
                customerLastName: customerName,
                saleDate,
                totalCost: Math.round(totalCost * 100) / 100,
              },
            });

        if (existingSale) {
          salesUpdated++;
        } else {
          salesCreated++;
        }

        // Upsert ConsignmentSaleLines
        for (const item of items) {
          const existing = await prisma.consignmentSaleLine.findFirst({
            where: { consignmentSaleId: sale.id, rugBarcode: item.barcode },
          });
          if (existing) {
            linesSkipped++;
          } else {
            await prisma.consignmentSaleLine.create({
              data: {
                consignmentSaleId: sale.id,
                rugBarcode: item.barcode,
                cost: Number(item.cost),
                transactionId: txId,
              },
            });
            linesCreated++;
          }
        }
      }

      // Fix status: SOLD items that already have a consignmentPaymentBatchId should be PAID.
      // These were linked to payment batches during an earlier import but their status was
      // not updated.
      const needsPaidStatus = soldItems.filter((i) => i.consignmentPaymentBatchId !== null);
      let itemsMarkedPaid = 0;

      for (const item of needsPaidStatus) {
        await prisma.consignmentItem.update({
          where: { id: item.id },
          data: {
            status: "PAID",
            paidDate: item.consignmentPaymentBatch?.batchDate ?? new Date(),
            updatedBy: userEmail,
          },
        });
        itemsMarkedPaid++;
      }

      // Count outstanding (SOLD, no payment batch)
      const outstanding = await prisma.consignmentItem.findMany({
        where: { status: "SOLD", consignmentPaymentBatchId: null },
        select: { cost: true },
      });
      const outstandingTotal = outstanding.reduce((sum, i) => sum + Number(i.cost), 0);

      return res.status(200).json({
        salesCreated,
        salesUpdated,
        linesCreated,
        linesSkipped,
        itemsMarkedPaid,
        outstandingItemCount: outstanding.length,
        outstandingTotal: Math.round(outstandingTotal * 100) / 100,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Rebuild failed";
      return res.status(500).json({ error: message });
    }
  },
);
