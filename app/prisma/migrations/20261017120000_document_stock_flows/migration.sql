-- Documents move stock correctly (ledger plan PR 2, phases 5-11).
--
-- - Each store's landing places beside its receiving place: pickup, returns,
--   quarantine, in transit (lib/inventory/places.ts), the store its orders
--   also draw from (one hop), and a move mode on stores and places
--   (lib/inventory/moveModes.ts).
-- - AppSettings.unmatchedStockStoreLocationId replaces the stock import's
--   store found by the name "Warehouse" (rule 61). It is set here from the
--   store that already holds the import's catch-all place (code UNMATCHED),
--   derived from data rather than guessed (rule 13); with no such place it
--   stays null and the import reports unmatched rows instead of writing them
--   (rule 63). Measured before writing: one restored copy held one UNMATCHED
--   place, at one store.
-- - InventoryTransfer.receivedQuantity, for receipts in parts: a transfer
--   already RECEIVED has received all of it.
-- - Return.quantity becomes fractional; the place a returned piece was put and
--   where it was put back are recorded; writtenOffAt records a write-off from
--   the returned-stock queue apart from the return's status.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "unmatchedStockStoreLocationId" INTEGER;

-- AlterTable
ALTER TABLE "InventoryTransfer" ADD COLUMN     "receivedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Return" ADD COLUMN     "receivedStockLocationId" INTEGER,
ADD COLUMN     "restockedStockLocationId" INTEGER,
ADD COLUMN     "writtenOffAt" TIMESTAMP(3),
ALTER COLUMN "quantity" SET DEFAULT 1,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3);

-- AlterTable
ALTER TABLE "StockLocation" ADD COLUMN     "moveMode" TEXT;

-- AlterTable
ALTER TABLE "StoreLocation" ADD COLUMN     "fulfilmentStoreLocationId" INTEGER,
ADD COLUMN     "moveMode" TEXT,
ADD COLUMN     "pickupStockLocationId" INTEGER,
ADD COLUMN     "quarantineStockLocationId" INTEGER,
ADD COLUMN     "returnsStockLocationId" INTEGER,
ADD COLUMN     "transitStockLocationId" INTEGER;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_pickupStockLocationId_fkey" FOREIGN KEY ("pickupStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_returnsStockLocationId_fkey" FOREIGN KEY ("returnsStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_quarantineStockLocationId_fkey" FOREIGN KEY ("quarantineStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_transitStockLocationId_fkey" FOREIGN KEY ("transitStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_fulfilmentStoreLocationId_fkey" FOREIGN KEY ("fulfilmentStoreLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_receivedStockLocationId_fkey" FOREIGN KEY ("receivedStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_restockedStockLocationId_fkey" FOREIGN KEY ("restockedStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_unmatchedStockStoreLocationId_fkey" FOREIGN KEY ("unmatchedStockStoreLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The import's catch-all store, from where its catch-all place already is.
UPDATE "AppSettings"
SET "unmatchedStockStoreLocationId" = (
  SELECT "storeLocationId" FROM "StockLocation" WHERE code = 'UNMATCHED' ORDER BY id LIMIT 1
)
WHERE "unmatchedStockStoreLocationId" IS NULL;

-- A received transfer has received all of it.
UPDATE "InventoryTransfer" SET "receivedQuantity" = quantity WHERE status = 'RECEIVED';

ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_received_within_quantity" CHECK (
  "receivedQuantity" >= 0 AND "receivedQuantity" <= quantity
);
