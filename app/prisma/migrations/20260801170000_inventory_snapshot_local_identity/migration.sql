-- InventorySnapshot: identity moves from another system's ids to holt's own.
--
-- Was keyed on (externalId, stockLocation, snapshotDate) -- the POS's product
-- id and a free-text POS location. Product.externalId is nullable, so every
-- product created natively in holt was silently absent from its own physical
-- count.
--
-- DROP AND RECREATE rather than backfill. This is a transient working table:
-- /api/inventory/clear-snapshot wipes it wholesale and it is regenerated per
-- count. A lossy backfill (rows whose externalId matches no Product, location
-- strings that resolve to no StockLocation alias) would be strictly worse than
-- regenerating. ANY IN-FLIGHT SNAPSHOT MUST BE REGENERATED AFTER THIS DEPLOYS
-- -- from Physical Inventory Hub, Step 1.
--
-- InventoryFreeze is untouched; it remains the durable point-in-time record.

DROP TABLE IF EXISTS "InventorySnapshot";

CREATE TYPE "InventorySnapshotSource" AS ENUM ('LOCAL', 'IMPORT');

CREATE TABLE "InventorySnapshot" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "stockLocationId" INTEGER,
    "quantity" DOUBLE PRECISION NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "InventorySnapshotSource" NOT NULL DEFAULT 'LOCAL',
    "externalId" INTEGER,
    "externalStockLocation" TEXT,
    "createdBy" TEXT,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventorySnapshot_snapshotDate_productId_storeLocationId_key"
  ON "InventorySnapshot"("snapshotDate", "productId", "storeLocationId");
CREATE INDEX "InventorySnapshot_productId_idx" ON "InventorySnapshot"("productId");
CREATE INDEX "InventorySnapshot_storeLocationId_idx" ON "InventorySnapshot"("storeLocationId");
CREATE INDEX "InventorySnapshot_snapshotDate_idx" ON "InventorySnapshot"("snapshotDate");

ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_storeLocationId_fkey"
  FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_stockLocationId_fkey"
  FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
