-- InventoryPosition: one row per place, kept by the single writer.
--
-- The unique key on (productId, storeLocationId, stockLocationId, salesOrderId)
-- holds two nullable columns, and Postgres treats NULLs as DISTINCT in a unique
-- index unless declared NULLS NOT DISTINCT (this one is not, see 0_init). So it
-- never stopped duplicate free-stock rows, and four routes upserted through it
-- (receive, return restock, transfer cancel, admin position create). Those
-- upserts could never match a free row, so each call created another one
-- (CLAUDE.md rule 64). Every write now goes through lib/inventory/ledger.ts,
-- which merges into the existing row for a place.
--
-- 1. Merge the duplicates already written: sum each place's rows into its
--    oldest row and delete the rest. Lossless -- the units are summed, not
--    chosen between. GROUP BY treats NULLs as equal, which is exactly the
--    grouping the old index failed to enforce.
-- 2. Drop the unique key, so an upsert through it no longer compiles.
-- 3. Index the lookups the ledger makes: one place (product, store, stock
--    location, order) and one order's committed rows.

-- Hold off concurrent writers (e.g. the previous app version still running
-- during a deploy) for the length of this migration, which runs as one
-- transaction: a row incremented between the snapshot below and the DELETE
-- would otherwise lose that increment. Reads are not blocked.
LOCK TABLE "InventoryPosition" IN EXCLUSIVE MODE;

CREATE TEMP TABLE "_inventory_position_merge" AS
SELECT
  MIN("id")      AS "keepId",
  SUM("quantity") AS "total",
  MAX("notes")   AS "anyNotes",
  "productId",
  "storeLocationId",
  "stockLocationId",
  "salesOrderId"
FROM "InventoryPosition"
GROUP BY "productId", "storeLocationId", "stockLocationId", "salesOrderId"
HAVING COUNT(*) > 1;

UPDATE "InventoryPosition" p
SET "quantity" = m."total",
    "notes"    = COALESCE(p."notes", m."anyNotes"),
    "updated"  = CURRENT_TIMESTAMP
FROM "_inventory_position_merge" m
WHERE p."id" = m."keepId";

DELETE FROM "InventoryPosition" p
USING "_inventory_position_merge" m
WHERE p."id" <> m."keepId"
  AND p."productId" = m."productId"
  AND p."storeLocationId" = m."storeLocationId"
  AND p."stockLocationId" IS NOT DISTINCT FROM m."stockLocationId"
  AND p."salesOrderId" IS NOT DISTINCT FROM m."salesOrderId";

DROP TABLE "_inventory_position_merge";

DROP INDEX IF EXISTS "InventoryPosition_productId_storeLocationId_stockLocationId_key";

CREATE INDEX "InventoryPosition_productId_storeLocationId_stockLocationId_idx"
  ON "InventoryPosition"("productId", "storeLocationId", "stockLocationId");

CREATE INDEX "InventoryPosition_salesOrderId_idx"
  ON "InventoryPosition"("salesOrderId");
