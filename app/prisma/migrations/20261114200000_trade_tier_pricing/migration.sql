-- GAP-06 part C: a customer's trade tier prices their lines. A line sold at the
-- tier's price records the tier and its percent then, so a report or a later
-- edit knows why it is below its list price (lib/pricing/tradeTier.ts).

-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN     "tradeDiscountPercent" DECIMAL(5,2),
ADD COLUMN     "tradeTierId" INTEGER;

-- CreateIndex
CREATE INDEX "OrderLineItem_tradeTierId_idx" ON "OrderLineItem"("tradeTierId");

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_tradeTierId_fkey" FOREIGN KEY ("tradeTierId") REFERENCES "TradeTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A recorded trade percent takes something off and no more than everything.
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_tradeDiscountPercent_range" CHECK (
  "tradeDiscountPercent" IS NULL OR ("tradeDiscountPercent" > 0 AND "tradeDiscountPercent" <= 100)
);
