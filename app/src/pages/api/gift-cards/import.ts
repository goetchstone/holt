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
        select: { id: true },
      });

      if (existing) {
        // Holt is the record for a card once it's here. A re-import only fills in a card nothing
        // has touched since it came in: one retired or used in Holt keeps what Holt says, and the
        // row says why. The card is locked and read inside the transaction, so a spend or a move
        // made meanwhile can't be undone by a stale read.
        const outcome = await prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<Array<{ status: string; currentBalance: unknown }>>`
            SELECT status, "currentBalance" FROM "GiftCard" WHERE id = ${existing.id} FOR UPDATE`;
          const card = rows[0];
          if (isClosedCard(card.status)) return "retired" as const;
          const used = await tx.giftCardTransaction.count({
            where: { giftCardId: existing.id, transactionType: { not: "IMPORT" } },
          });
          if (used > 0) return "used" as const;
          const before = Math.round(Number(card.currentBalance) * 100) / 100;
          const change = Math.round((remainingAmount - before) * 100) / 100;
          await tx.giftCard.update({
            where: { id: existing.id },
            data: {
              ...(externalCode ? { externalCode } : {}),
              initialAmount,
              currentBalance: remainingAmount,
              status,
              ...(activatedAt ? { activatedAt } : {}),
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
          return "updated" as const;
        }, TX_TIMEOUT.LONG);
        if (outcome === "retired") {
          errors.push(
            `Row ${rowNum} (${row.Code || barcode}): this card was retired in Holt, so the report doesn't change it`,
          );
        } else if (outcome === "used") {
          errors.push(
            `Row ${rowNum} (${row.Code || barcode}): this card has been used in Holt, so its balance there stands`,
          );
        } else {
          updatedCount++;
        }
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
