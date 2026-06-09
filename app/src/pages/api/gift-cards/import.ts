// /app/src/pages/api/gift-cards/import.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getErrorMessage } from "@/lib/toastError";
import { getErrorCode } from "@/lib/errorCode";

export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

interface VoucherRow {
  Creationdate: string;
  Code: string;
  Referenceno: string;
  Initialamount: string;
  Remainingamount: string;
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const records: VoucherRow[] = req.body.records;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: "No records provided" });
  }

  const createdBy = session.user?.email || null;
  let importedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const rowNum = i + 2; // 1-indexed + header row

    try {
      const barcode = (row.Referenceno || "").trim();
      const externalCode = (row.Code || "").trim();

      if (!barcode) {
        skippedCount++;
        continue;
      }

      const initialAmount = Number.parseFloat(row.Initialamount) || 0;
      const remainingAmount = Number.parseFloat(row.Remainingamount) || 0;
      const status = remainingAmount > 0 ? "ACTIVE" : "REDEEMED";

      let activatedAt: Date | null = null;
      if (row.Creationdate) {
        const parsed = new Date(row.Creationdate);
        if (!Number.isNaN(parsed.getTime())) {
          activatedAt = parsed;
        }
      }

      const existing = await prisma.giftCard.findUnique({
        where: { barcode },
      });

      if (existing) {
        await prisma.giftCard.update({
          where: { barcode },
          data: {
            externalCode: externalCode || existing.externalCode,
            initialAmount,
            currentBalance: remainingAmount,
            status,
            activatedAt: activatedAt || existing.activatedAt,
            updatedBy: createdBy,
          },
        });
        updatedCount++;
      } else {
        await prisma.$transaction(async (tx) => {
          const card = await tx.giftCard.create({
            data: {
              barcode,
              externalCode: externalCode || null,
              initialAmount,
              currentBalance: remainingAmount,
              status,
              activatedAt,
              createdBy,
            },
          });

          await tx.giftCardTransaction.create({
            data: {
              giftCardId: card.id,
              transactionType: "IMPORT",
              amount: initialAmount,
              balanceBefore: 0,
              balanceAfter: remainingAmount,
              reference: externalCode || null,
              notes: "Imported from the POS voucher report",
              createdBy,
            },
          });
        }, TX_TIMEOUT.LONG);
        importedCount++;
      }
    } catch (err: unknown) {
      const code = row.Code || `row ${rowNum}`;
      if (getErrorCode(err) === "P2002") {
        errors.push(`Row ${rowNum} (${code}): duplicate barcode or POS code`);
      } else {
        errors.push(`Row ${rowNum} (${code}): ${getErrorMessage(err, "Import failed")}`);
      }
    }
  }

  return res.status(200).json({
    success: true,
    importedCount,
    updatedCount,
    skippedCount,
    errorCount: errors.length,
    errors: errors.slice(0, 50),
    totalProcessed: records.length,
  });
});
