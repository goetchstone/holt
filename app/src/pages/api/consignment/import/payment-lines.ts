// /app/src/pages/api/consignment/import/payment-lines.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getPrimaryConsignmentVendorId } from "@/lib/consignmentVendor";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { safeString, safeFloat, safeDate } from "@/lib/importHelpers";

import { requirePermission } from "@/lib/auth/requireAuth";
export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

interface PaymentRow {
  cost?: unknown;
  kf_payment_id?: unknown;
  kf_transaction_id?: unknown;
  rug_id?: unknown;
  check_number?: unknown;
  date?: unknown;
  total_payment?: unknown;
}

export default requirePermission(
  "purchasing.write",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { rows } = req.body as { rows: PaymentRow[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const userEmail = session.user.email;

    // Group rows by kf_payment_id
    const groups = new Map<string, PaymentRow[]>();
    for (const row of rows) {
      const paymentId = safeString(row.kf_payment_id);
      if (!paymentId) continue;
      const group = groups.get(paymentId) || [];
      group.push(row);
      groups.set(paymentId, group);
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // The consigning vendor, by flag. These routes used to UPSERT a vendor
        // named "Marjan International" when they could not find one -- which is
        // exactly how a catalog ends up with "Marjan", "Marjan Intl" and
        // "MARJANINT" as three separate suppliers. A missing configuration is
        // now an error, not a new row.
        const consignmentVendorId = await getPrimaryConsignmentVendorId(tx);
        if (!consignmentVendorId) {
          throw new Error(
            "No consignment vendor configured. Set isConsignment on the vendor before importing.",
          );
        }
        const vendor = { id: consignmentVendorId };

        let batches = 0;
        let itemsLinked = 0;

        for (const [paymentId, groupRows] of groups) {
          const firstRow = groupRows[0];
          const checkNumber = safeString(firstRow.check_number);
          const batchDate = safeDate(firstRow.date) || new Date();
          const totalAmount = safeFloat(firstRow.total_payment);

          // Find or create the payment batch using the FM payment ID as a reference
          let batch = await tx.consignmentPaymentBatch.findFirst({
            where: { vendorId: vendor.id, checkNumber: paymentId },
          });

          if (!batch) {
            batch = await tx.consignmentPaymentBatch.create({
              data: {
                vendorId: vendor.id,
                batchDate,
                periodStart: batchDate,
                periodEnd: batchDate,
                checkNumber: checkNumber || paymentId,
                totalAmount,
                isPaid: true,
                createdBy: userEmail,
              },
            });
            batches++;
          }

          for (const row of groupRows) {
            const rugBarcode = safeString(row.rug_id);
            if (!rugBarcode) continue;

            const updated = await tx.consignmentItem
              .update({
                where: { barcode: rugBarcode },
                data: {
                  consignmentPaymentBatchId: batch.id,
                  status: "PAID",
                  paidDate: batchDate,
                  updatedBy: userEmail,
                },
              })
              .catch(() => null);

            if (updated) itemsLinked++;
          }

          // Update batch item count
          const linkedCount = await tx.consignmentItem.count({
            where: { consignmentPaymentBatchId: batch.id },
          });
          await tx.consignmentPaymentBatch.update({
            where: { id: batch.id },
            data: { itemCount: linkedCount },
          });
        }

        return { batches, itemsLinked };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      return res.status(500).json({ error: message });
    }
  },
);
