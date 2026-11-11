-- A gift card's value changes only when money moves (owner, 2026-11-11): Void and Adjust are
-- gone, and a card is retired by moving its balance to a new card, linked here.

-- AlterEnum
ALTER TYPE "GiftCardStatus" ADD VALUE 'REPLACED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GiftCardTransactionType" ADD VALUE 'TRANSFER';
ALTER TYPE "GiftCardTransactionType" ADD VALUE 'REFUND';

-- AlterTable
ALTER TABLE "GiftCard" ADD COLUMN     "replacedById" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_replacedById_key" ON "GiftCard"("replacedById");

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "GiftCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
