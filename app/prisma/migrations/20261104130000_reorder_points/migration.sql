-- GAP-14: reorder points and the low-stock alert.
--
--   ReorderPoint            "keep at least this many here", per product per store
--   AppSettings.lowStock*   who gets the daily list, and when; off to start
-- Additive: one table and three nullable columns.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "lowStockAlertEmails" TEXT,
ADD COLUMN     "lowStockAlertHour" INTEGER,
ADD COLUMN     "lowStockAlertedOn" TEXT;

-- CreateTable
CREATE TABLE "ReorderPoint" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "minQuantity" DECIMAL(12,3) NOT NULL,
    "orderQuantity" DECIMAL(12,3),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ReorderPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReorderPoint_storeLocationId_idx" ON "ReorderPoint"("storeLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderPoint_productId_storeLocationId_key" ON "ReorderPoint"("productId", "storeLocationId");

-- AddForeignKey
ALTER TABLE "ReorderPoint" ADD CONSTRAINT "ReorderPoint_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderPoint" ADD CONSTRAINT "ReorderPoint_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A level is more than nothing, and so is a least order. An alert goes at an hour
-- of the store's day. The routes check these too; these are the floor under them.
ALTER TABLE "ReorderPoint" ADD CONSTRAINT "ReorderPoint_minQuantity_positive"
  CHECK ("minQuantity" > 0);
ALTER TABLE "ReorderPoint" ADD CONSTRAINT "ReorderPoint_orderQuantity_positive"
  CHECK ("orderQuantity" IS NULL OR "orderQuantity" > 0);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_lowStockAlertHour_range"
  CHECK ("lowStockAlertHour" IS NULL OR ("lowStockAlertHour" >= 0 AND "lowStockAlertHour" <= 23));
