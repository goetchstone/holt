-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN     "giftCardId" INTEGER,
ADD COLUMN     "giftCardNumber" TEXT;

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "giftCardsRefundable" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
