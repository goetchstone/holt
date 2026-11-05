-- GAP-17: how often a place gets counted (lib/inventory/countSchedule.ts). Null
-- means it isn't on a schedule, which is every place until a store sets one.
ALTER TABLE "StockLocation" ADD COLUMN "countEveryDays" INTEGER;

ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_countEveryDays_range" CHECK (
  "countEveryDays" IS NULL OR "countEveryDays" BETWEEN 1 AND 3650
);
