-- Replaces a hardcoded deployment convention with a real data flag.
--
-- Shared inventory code (lib/inventory/allocation.ts) and the Buyers Report
-- (lib/reports/buyersReport.ts) both decided "this stock is already spoken
-- for" by testing `StockLocation.name ILIKE 'customer%'` -- an Ordorite /
-- Saybrook naming convention baked into src/. Any deployment that names its
-- holding locations anything else silently got wrong availability: stock
-- promised to a customer counted as free to sell. CLAUDE.md rule 61 --
-- deployment facts are config, not literals in src/.
--
-- THE BACKFILL BELOW IS THE WHOLE EQUIVALENCE GUARANTEE. It sets the new
-- flag on exactly the rows the old string test matched, so an existing
-- Ordorite-fed database (Saybrook) classifies every position identically
-- after this migration as before it. Nothing else preserves that: the
-- application code no longer looks at the name at all.
--
-- No index. The flag is never a filter predicate -- the Buyers Report reads
-- it inside a CASE over a full-table aggregate, and allocation.ts reaches it
-- through the InventoryPosition -> StockLocation FK (already indexed). The
-- StockLocation table is dozens of rows; a low-cardinality boolean index on
-- it would never be chosen.

-- AlterTable
ALTER TABLE "StockLocation" ADD COLUMN     "holdsCommittedStock" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: preserve the pre-existing Ordorite "Customer%" convention.
UPDATE "StockLocation" SET "holdsCommittedStock" = true WHERE "name" ILIKE 'customer%';
