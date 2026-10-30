-- GAP-02: landed cost.
--
--   LandedCostSplit                  how a charge is spread across a PO's lines.
--   PurchaseOrderCharge              freight, duty, crating on a PO.
--   Product.landedCost               the running average landed unit cost; null
--                                    until the first native receipt with a cost,
--                                    when baseCost stands in.
--   ReceivingRecord.landedUnitCost   what a receipt brought into that average.
--   AppSettings.landedCostSplit      the store's default split (by value).
CREATE TYPE "LandedCostSplit" AS ENUM ('VALUE', 'QUANTITY', 'VOLUME');

ALTER TABLE "Product" ADD COLUMN "landedCost" DECIMAL(65,30);

ALTER TABLE "ReceivingRecord" ADD COLUMN "landedUnitCost" DECIMAL(65,30);

ALTER TABLE "AppSettings" ADD COLUMN "landedCostSplit" "LandedCostSplit" NOT NULL DEFAULT 'VALUE';

CREATE TABLE "PurchaseOrderCharge" (
    "id" SERIAL NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "splitBy" "LandedCostSplit" NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "PurchaseOrderCharge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseOrderCharge_purchaseOrderId_idx" ON "PurchaseOrderCharge"("purchaseOrderId");

ALTER TABLE "PurchaseOrderCharge" ADD CONSTRAINT "PurchaseOrderCharge_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
