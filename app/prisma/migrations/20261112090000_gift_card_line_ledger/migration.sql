-- AlterTable
ALTER TABLE "GiftCardTransaction" ADD COLUMN     "orderLineItemId" INTEGER;

-- CreateIndex
CREATE INDEX "GiftCardTransaction_orderLineItemId_idx" ON "GiftCardTransaction"("orderLineItemId");

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
