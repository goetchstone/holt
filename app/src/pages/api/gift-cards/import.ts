// /app/src/pages/api/gift-cards/import.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { getErrorMessage } from "@/lib/toastError";
import { getErrorCode } from "@/lib/errorCode";
import { isClosedCard } from "@/lib/giftCardLedger";

/** An amount from the report: a number, or null when the cell can't be read. */
function readAmount(cell: string | undefined): number | null {
  const n = Number.parseFloat(cell ?? "");
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

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

export default requirePermission("payment.giftcard.issue", async (req, res, session) => {
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

      // An unreadable amount is reported, never read as $0: that wiped a card's balance.
      const initialAmount = readAmount(row.Initialamount);
      const remainingAmount = readAmount(row.Remainingamount);
      if (initialAmount === null || remainingAmount === null) {
        errors.push(`Row ${rowNum} (${row.Code || barcode}): the amount can't be read`);
        continue;
      }
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
        // A card retired in Holt stays retired: a re-import never brings its balance back.
        if (isClosedCard(existing.status)) {
          skippedCount++;
          continue;
        }
        // A re-import takes the report's balance, and any change is on the card's history as
        // an IMPORT row, in one transaction with it (the money rule, lib/giftCardLedger.ts).
        const before = Math.round(Number(existing.currentBalance) * 100) / 100;
        const change = Math.round((remainingAmount - before) * 100) / 100;
        await prisma.$transaction(async (tx) => {
          await tx.giftCard.update({
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
          if (change !== 0) {
            await tx.giftCardTransaction.create({
              data: {
                giftCardId: existing.id,
                transactionType: "IMPORT",
                amount: change,
                balanceBefore: before,
                balanceAfter: remainingAmount,
                reference: externalCode || null,
                notes: "Re-imported from the POS voucher report",
                createdBy,
              },
            });
          }
        }, TX_TIMEOUT.LONG);
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
              // The balance it arrives with: balanceBefore + amount = balanceAfter. The card's
              // first value is on the card itself (initialAmount).
              amount: remainingAmount,
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
