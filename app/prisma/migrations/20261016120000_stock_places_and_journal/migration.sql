-- Every unit has a place, and every change to stock is written down.
--
-- Ledger plan phases 3 and 4 (docs/domains/inventory.md, "Roadmap").
--
-- 1. A position with no stock location ("at the store, nowhere in it") moves to
--    its store's receiving place: StoreLocation.defaultReceivingStockLocationId,
--    or a place coded RECEIVING that this migration creates and points the
--    setting at, the same default lib/inventory/places.ts applies at run time.
-- 2. Rows for the same place are merged (moving null rows can land two rows on
--    one place), and rows holding nothing are removed. On the restored copies
--    measured before this was written there were no null-place rows; one held
--    2,843 negative rows and 5 zero rows, all written before the single writer.
--    The POS import already reads a negative on-hand as zero
--    (negativeClampedToZero), so removing them leaves each place where the
--    import would put it. A place cannot hold less than nothing.
-- 3. stockLocationId becomes NOT NULL, and quantity > 0 is a CHECK.
-- 4. StockMovement, the journal: append-only (trigger), positive quantities,
--    at least one side in the books, and each side a whole place or nothing.
-- 5. One OPENING movement per position, so the journal sums to the balance
--    from the first day. ledgerDrift() asserts it keeps doing so.

-- 1. Receiving places for stores that hold null-place stock and have none.
INSERT INTO "StockLocation" ("storeLocationId", "code", "name", "locationType", "locationAliases", "createdBy", "updated")
SELECT DISTINCT ip."storeLocationId", 'RECEIVING', 'Receiving', 'RECEIVING', ARRAY[]::text[], 'system', CURRENT_TIMESTAMP
FROM "InventoryPosition" ip
JOIN "StoreLocation" s ON s.id = ip."storeLocationId"
WHERE ip."stockLocationId" IS NULL
  AND s."defaultReceivingStockLocationId" IS NULL
ON CONFLICT ("storeLocationId", "code") DO NOTHING;

UPDATE "StoreLocation" s
SET "defaultReceivingStockLocationId" = sl.id
FROM "StockLocation" sl
WHERE sl."storeLocationId" = s.id
  AND sl.code = 'RECEIVING'
  AND s."defaultReceivingStockLocationId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "InventoryPosition" ip
    WHERE ip."storeLocationId" = s.id AND ip."stockLocationId" IS NULL
  );

UPDATE "InventoryPosition" ip
SET "stockLocationId" = s."defaultReceivingStockLocationId"
FROM "StoreLocation" s
WHERE s.id = ip."storeLocationId"
  AND ip."stockLocationId" IS NULL;

-- 2. Merge rows that share a place into the oldest, then drop empty rows.
WITH grouped AS (
  SELECT MIN(id) AS keep_id, SUM(quantity) AS total,
         "productId", "storeLocationId", "stockLocationId", "salesOrderId"
  FROM "InventoryPosition"
  GROUP BY "productId", "storeLocationId", "stockLocationId", "salesOrderId"
  HAVING COUNT(*) > 1
)
UPDATE "InventoryPosition" ip
SET quantity = g.total
FROM grouped g
WHERE ip.id = g.keep_id;

DELETE FROM "InventoryPosition" ip
USING "InventoryPosition" keeper
WHERE keeper."productId" = ip."productId"
  AND keeper."storeLocationId" = ip."storeLocationId"
  AND keeper."stockLocationId" = ip."stockLocationId"
  AND keeper."salesOrderId" IS NOT DISTINCT FROM ip."salesOrderId"
  AND keeper.id < ip.id;

DELETE FROM "InventoryPosition" WHERE quantity <= 0;

-- 3. Every unit is somewhere, and a row always holds something.
ALTER TABLE "InventoryPosition" DROP CONSTRAINT "InventoryPosition_stockLocationId_fkey";
ALTER TABLE "InventoryPosition" ALTER COLUMN "stockLocationId" SET NOT NULL;
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_stockLocationId_fkey" FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_quantity_positive" CHECK (quantity > 0);

-- 4. The journal.
CREATE TABLE "StockMovement" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "fromStoreLocationId" INTEGER,
    "fromStockLocationId" INTEGER,
    "fromSalesOrderId" INTEGER,
    "toStoreLocationId" INTEGER,
    "toStockLocationId" INTEGER,
    "toSalesOrderId" INTEGER,
    "reason" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" INTEGER,
    "actor" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockMovement_productId_occurredAt_idx" ON "StockMovement"("productId", "occurredAt");
CREATE INDEX "StockMovement_sourceType_sourceId_idx" ON "StockMovement"("sourceType", "sourceId");

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_fromStoreLocationId_fkey" FOREIGN KEY ("fromStoreLocationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_fromStockLocationId_fkey" FOREIGN KEY ("fromStockLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_toStoreLocationId_fkey" FOREIGN KEY ("toStoreLocationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_toStockLocationId_fkey" FOREIGN KEY ("toStockLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_quantity_positive" CHECK (quantity > 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_has_a_side" CHECK (
  "fromStoreLocationId" IS NOT NULL OR "toStoreLocationId" IS NOT NULL
);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_whole_places" CHECK (
  ("fromStoreLocationId" IS NULL) = ("fromStockLocationId" IS NULL)
  AND ("toStoreLocationId" IS NULL) = ("toStockLocationId" IS NULL)
  AND ("fromSalesOrderId" IS NULL OR "fromStoreLocationId" IS NOT NULL)
  AND ("toSalesOrderId" IS NULL OR "toStoreLocationId" IS NOT NULL)
);

-- The journal is never rewritten: a correction is a new movement.
CREATE OR REPLACE FUNCTION enforce_stock_movement_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'StockMovement is append-only (id=%): correct stock with a new movement through lib/inventory/ledger.ts, never by changing history.',
    OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stock_movement_append_only ON "StockMovement";
CREATE TRIGGER stock_movement_append_only
BEFORE UPDATE OR DELETE ON "StockMovement"
FOR EACH ROW
EXECUTE FUNCTION enforce_stock_movement_append_only();

-- 5. The balance on the day the journal starts.
INSERT INTO "StockMovement" ("productId", "quantity", "toStoreLocationId", "toStockLocationId", "toSalesOrderId", "reason", "actor", "note")
SELECT "productId", quantity, "storeLocationId", "stockLocationId", "salesOrderId", 'OPENING', 'system', 'Balance when the journal started'
FROM "InventoryPosition"
ORDER BY id;
