-- A delivery run's truck is a place (lib/fulfilment/truck.ts, DECISIONS #25).
--
-- Loaded units stayed at the loading bay on the books until they were
-- delivered, so a failed stop's units read as at the bay while they were on
-- the truck. Loading a run now moves them onto a place of the run's own: a
-- StockLocation that names the run. Null on every existing place, and on every
-- place a person sets up; no backfill, since no run has loaded onto one yet.
--
-- RESTRICT: a place that has held stock has journal rows, and runs are never
-- deleted, so nothing should take a truck place out from under its journal.
ALTER TABLE "StockLocation" ADD COLUMN     "deliveryRunId" INTEGER;

CREATE INDEX "StockLocation_deliveryRunId_idx" ON "StockLocation"("deliveryRunId");

ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_deliveryRunId_fkey" FOREIGN KEY ("deliveryRunId") REFERENCES "DeliveryRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
