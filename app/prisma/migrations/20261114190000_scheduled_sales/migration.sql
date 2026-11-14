-- GAP-06 part B: scheduled sale prices. A sale names a run of the store's days and
-- a sale price for each of its products; whether one applies is decided at read
-- time (lib/pricing/salePrice.ts), so nothing is written when a sale starts or ends.

-- CreateTable
CREATE TABLE "Sale" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,
    "endedEarlyAt" TIMESTAMP(3),
    "endedEarlyBy" TEXT,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" SERIAL NOT NULL,
    "saleId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "salePrice" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sale_startsOn_endsOn_idx" ON "Sale"("startsOn", "endsOn");

-- CreateIndex
CREATE INDEX "SaleItem_productId_idx" ON "SaleItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleItem_saleId_productId_key" ON "SaleItem"("saleId", "productId");

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A sale's last day is on or after its first (endsOn is inclusive).
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_dates_ordered" CHECK ("endsOn" >= "startsOn");

-- Ended early is who and when together, or neither.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_endedEarly_complete" CHECK (
  ("endedEarlyAt" IS NULL) = ("endedEarlyBy" IS NULL)
);

-- A sale price is a price: above zero.
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_salePrice_positive" CHECK ("salePrice" > 0);
